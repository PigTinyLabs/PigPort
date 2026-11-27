// scrcpy 5.x video and control protocol. Frame payloads stay binary through Tauri IPC.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, Response};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex, Notify};
use tokio::time::{sleep, timeout, Instant};

const REMOTE_JAR: &str = "/data/local/tmp/playbridge-scrcpy-server.jar";
const SESSION_FLAG: u64 = 1 << 63;
const CONFIG_FLAG: u64 = 1 << 62;
const KEY_FLAG: u64 = 1 << 61;
const MAX_PACKET_BYTES: usize = 8 * 1024 * 1024;
const MAX_IN_FLIGHT_FRAMES: u64 = 12;
const MAX_PENDING_INPUTS: usize = 128;
const ACTION_MOVE: u8 = 2;
static NEXT_SCID: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamOptions {
    max_size: u32,
    max_fps: u32,
    bit_rate: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamMeta {
    device_name: String,
    codec: &'static str,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum StreamEvent {
    Meta(StreamMeta),
    Log(String),
    Closed(String),
}

#[derive(Default)]
pub struct StreamState {
    active: Arc<Mutex<Option<Arc<Session>>>>,
    lifetime: Arc<AsyncMutex<()>>,
}

struct Session {
    cancel: watch::Sender<bool>,
    inputs: InputQueue,
    frames: FrameCredits,
}

impl StreamState {
    pub async fn start(
        &self,
        adb_path: PathBuf,
        serial: String,
        resource_dir: PathBuf,
        options: StreamOptions,
        frames: Channel<Response>,
        events: Channel<StreamEvent>,
    ) -> Result<(), String> {
        if serial.is_empty() || serial.len() > 1024 || serial.contains('\0') {
            return Err("Select a valid Android device.".into());
        }

        let (cancel, cancelled) = watch::channel(false);
        let session = Arc::new(Session {
            cancel,
            inputs: InputQueue::default(),
            frames: FrameCredits::new(frames.id()),
        });
        let previous = self.active.lock().unwrap().replace(session.clone());
        if let Some(previous) = previous {
            previous.cancel.send_replace(true);
        }

        let active = self.active.clone();
        let lifetime = self.lifetime.clone();
        let (ready, started) = oneshot::channel();
        tauri::async_runtime::spawn(async move {
            // A new session waits for the previous ADB forward and server to finish.
            let _guard = lifetime.lock().await;
            let mut ready = Some(ready);
            let mut connection = Connection::new(adb_path, serial);
            let result = run_session(
                &mut connection,
                &session,
                cancelled,
                resource_dir,
                options,
                &frames,
                &events,
                &mut ready,
            )
            .await;

            connection.shutdown().await;
            {
                let mut current = active.lock().unwrap();
                if current
                    .as_ref()
                    .is_some_and(|other| Arc::ptr_eq(other, &session))
                {
                    *current = None;
                }
            }
            match (ready, result) {
                (Some(ready), result) => {
                    let _ = ready.send(Err(result
                        .err()
                        .unwrap_or_else(|| "Android playback stopped.".into())));
                }
                (None, result) => {
                    let _ = events.send(StreamEvent::Closed(
                        result.err().unwrap_or_else(|| "stopped".into()),
                    ));
                }
            }
        });

        started
            .await
            .map_err(|_| "Android playback ended before startup.".to_string())?
    }

    pub fn stop(&self) {
        if let Some(session) = self.active.lock().unwrap().as_ref() {
            session.cancel.send_replace(true);
        }
    }

    pub fn active(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }

    pub async fn shutdown(&self) {
        self.stop();
        drop(self.lifetime.lock().await);
    }

    pub fn ack_frames(&self, channel_id: u32, count: u32) {
        let session = self.active.lock().unwrap();
        if let Some(session) = session
            .as_ref()
            .filter(|s| s.frames.channel_id == channel_id)
        {
            session.frames.acknowledge(count);
        }
    }

    pub fn touch(&self, action: u8, id: u32, x: f64, y: f64, width: u32, height: u32) {
        if let Some(input) = encode_touch(action, id, x, y, width, height) {
            self.send_input(input);
        }
    }

    pub fn nav(&self, button: &str) {
        let key = match button {
            "home" => 3,
            "back" => 4,
            "recents" => 187,
            _ => return,
        };
        self.send_input(encode_keypress(key));
    }

    fn send_input(&self, input: ControlMessage) {
        let session = self.active.lock().unwrap();
        if let Some(session) = session.as_ref() {
            if !session.inputs.push(input) {
                // Closing the control socket releases all pointers on the device.
                session.cancel.send_replace(true);
            }
        }
    }
}

struct FrameCredits {
    channel_id: u32,
    sent: AtomicU64,
    acked: AtomicU64,
    available: Notify,
}

impl FrameCredits {
    fn new(channel_id: u32) -> Self {
        Self {
            channel_id,
            sent: AtomicU64::new(0),
            acked: AtomicU64::new(0),
            available: Notify::new(),
        }
    }

    fn acknowledge(&self, count: u32) {
        let sent = self.sent.load(Ordering::Acquire);
        // StreamState serializes acknowledgement writers with its active-session lock.
        let acked = self.acked.load(Ordering::Relaxed);
        self.acked
            .store((acked + u64::from(count)).min(sent), Ordering::Release);
        self.available.notify_one();
    }

    async fn send(&self, frames: &Channel<Response>, bytes: Vec<u8>) -> Result<(), String> {
        timeout(Duration::from_secs(3), async {
            loop {
                let available = self.available.notified();
                let in_flight =
                    self.sent.load(Ordering::Acquire) - self.acked.load(Ordering::Acquire);
                if in_flight < MAX_IN_FLIGHT_FRAMES {
                    break;
                }
                available.await;
            }
        })
        .await
        .map_err(|_| {
            "Android video stopped responding. Reopen the player to reconnect.".to_string()
        })?;
        self.sent.fetch_add(1, Ordering::Release);
        frames.send(Response::new(bytes)).map_err(|e| e.to_string())
    }
}

#[derive(Default)]
struct InputQueue {
    pending: Mutex<VecDeque<ControlMessage>>,
    changed: Notify,
}

impl InputQueue {
    fn push(&self, input: ControlMessage) -> bool {
        let mut pending = self.pending.lock().unwrap();
        if let Some(last) = pending.back_mut() {
            if input.move_pointer.is_some() && last.move_pointer == input.move_pointer {
                *last = input;
                return true;
            }
        }
        if pending.len() == MAX_PENDING_INPUTS {
            if input.move_pointer.is_some() {
                return true;
            }
            let Some(move_index) = pending
                .iter()
                .position(|entry| entry.move_pointer.is_some())
            else {
                return false;
            };
            pending.remove(move_index);
        }
        pending.push_back(input);
        self.changed.notify_one();
        true
    }

    fn pop(&self) -> Option<ControlMessage> {
        self.pending.lock().unwrap().pop_front()
    }

    async fn write(&self, mut control: impl AsyncWrite + Unpin) -> Result<(), String> {
        loop {
            let changed = self.changed.notified();
            if let Some(message) = self.pop() {
                control
                    .write_all(&message.bytes[..message.len])
                    .await
                    .map_err(|e| format!("Android input disconnected: {e}"))?;
            } else {
                changed.await;
            }
        }
    }
}

struct ControlMessage {
    bytes: [u8; 32],
    len: usize,
    move_pointer: Option<u32>,
}

fn encode_touch(
    action: u8,
    id: u32,
    x: f64,
    y: f64,
    width: u32,
    height: u32,
) -> Option<ControlMessage> {
    let (width, height) = (u16::try_from(width).ok()?, u16::try_from(height).ok()?);
    if action > ACTION_MOVE || width == 0 || height == 0 || !x.is_finite() || !y.is_finite() {
        return None;
    }
    let x = x.round().clamp(0., f64::from(width - 1)) as i32;
    let y = y.round().clamp(0., f64::from(height - 1)) as i32;
    let pressure = if action == 1 { 0 } else { u16::MAX };
    let mut bytes = [0; 32];
    bytes[..2].copy_from_slice(&[2, action]);
    bytes[2..10].copy_from_slice(&u64::from(id).to_be_bytes());
    bytes[10..14].copy_from_slice(&x.to_be_bytes());
    bytes[14..18].copy_from_slice(&y.to_be_bytes());
    bytes[18..20].copy_from_slice(&width.to_be_bytes());
    bytes[20..22].copy_from_slice(&height.to_be_bytes());
    bytes[22..24].copy_from_slice(&pressure.to_be_bytes());
    Some(ControlMessage {
        bytes,
        len: 32,
        move_pointer: (action == ACTION_MOVE).then_some(id),
    })
}

fn encode_keypress(key: u32) -> ControlMessage {
    let mut bytes = [0; 32];
    bytes[2..6].copy_from_slice(&key.to_be_bytes());
    bytes[15] = 1;
    bytes[16..20].copy_from_slice(&key.to_be_bytes());
    ControlMessage {
        bytes,
        len: 28,
        move_pointer: None,
    }
}

struct Connection {
    adb: PathBuf,
    serial: String,
    port: Option<u16>,
    server: Option<Child>,
}

impl Connection {
    fn new(adb: PathBuf, serial: String) -> Self {
        Self {
            adb,
            serial,
            port: None,
            server: None,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.adb);
        command
            .args(["-s", &self.serial])
            .kill_on_drop(true)
            .stdin(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
    }

    async fn shutdown(&mut self) {
        if let Some(mut server) = self.server.take() {
            // Closing the sockets gives the server a chance to restore stay-awake settings.
            if !matches!(
                timeout(Duration::from_millis(350), server.wait()).await,
                Ok(Ok(_))
            ) {
                let _ = server.start_kill();
                let _ = timeout(Duration::from_secs(2), server.wait()).await;
            }
        }
        if let Some(port) = self.port.take() {
            let _ = adb_output(
                self.command()
                    .args(["forward", "--remove", &format!("tcp:{port}")]),
                Duration::from_secs(3),
            )
            .await;
        }
    }
}

async fn adb_output(command: &mut Command, max_wait: Duration) -> Result<String, String> {
    let output = timeout(max_wait, command.output())
        .await
        .map_err(|_| "ADB did not respond in time.".to_string())?
        .map_err(|e| format!("Could not run ADB: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ADB failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn cancelled(signal: &mut watch::Receiver<bool>) {
    if !*signal.borrow() {
        let _ = signal.changed().await;
    }
}

fn socket_id() -> u32 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    (elapsed.subsec_nanos() ^ std::process::id() ^ NEXT_SCID.fetch_add(1, Ordering::Relaxed))
        & 0x7fff_ffff
}

async fn run_session(
    connection: &mut Connection,
    session: &Session,
    mut cancel: watch::Receiver<bool>,
    resource_dir: PathBuf,
    options: StreamOptions,
    frames: &Channel<Response>,
    events: &Channel<StreamEvent>,
    ready: &mut Option<oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let (jar, version) = server_files(&resource_dir)?;
    let stopped = || "Android playback stopped.".to_string();
    let mut push = connection.command();
    push.arg("push").arg(&jar).arg(REMOTE_JAR);
    tokio::select! {
        biased;
        () = cancelled(&mut cancel) => return Err(stopped()),
        pushed = adb_output(&mut push, Duration::from_secs(60)) => pushed?,
    };

    let scid = format!("{:08x}", socket_id());
    let forwarded = adb_output(
        connection
            .command()
            .args(["forward", "tcp:0", &format!("localabstract:scrcpy_{scid}")]),
        Duration::from_secs(10),
    )
    .await?;
    let port = forwarded
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| "ADB did not report a forwarding port.".to_string())?;
    connection.port = Some(port);
    if *cancel.borrow() {
        return Err(stopped());
    }

    let mut server = connection
        .command()
        .args([
            "shell",
            &format!("CLASSPATH={REMOTE_JAR}"),
            "app_process",
            "/",
            "com.genymobile.scrcpy.Server",
            &version,
            &format!("scid={scid}"),
            "log_level=info",
            "tunnel_forward=true",
            "audio=false",
            "control=true",
            "video_codec=h264",
            "clipboard_autosync=false",
            &format!("max_size={}", options.max_size.min(4096)),
            &format!("max_fps={}", options.max_fps.min(120)),
            &format!(
                "video_bit_rate={}",
                options.bit_rate.clamp(100_000, 50_000_000)
            ),
            "stay_awake=true",
            "cleanup=true",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the Android capture server: {e}"))?;
    let stdout = server.stdout.take().expect("piped capture stdout");
    let stderr = server.stderr.take().expect("piped capture stderr");
    connection.server = Some(server);
    let server = connection.server.as_mut().unwrap();

    tokio::select! {
        biased;
        () = cancelled(&mut cancel) => Ok(()),
        result = server.wait() => Err(format!("Android capture server exited: {}", result.map_or_else(|e| e.to_string(), |status| status.to_string()))),
        result = stream_sockets(port, &session.inputs, &session.frames, frames, events, ready) => result,
        () = capture_logs(stdout, stderr, events) => unreachable!("log collection waits for session shutdown"),
    }
}

fn server_files(resources: &Path) -> Result<(PathBuf, String), String> {
    let jar = resources.join("scrcpy-server");
    let version = std::fs::read_to_string(resources.join("scrcpy-server.version"))
        .map_err(|_| "The Android capture server is missing from PigPort.".to_string())?;
    let version = version.trim();
    if !jar.is_file()
        || !version.starts_with("5.")
        || !version.bytes().all(|c| c.is_ascii_digit() || c == b'.')
    {
        return Err("PigPort needs the packaged scrcpy 5.x capture server.".into());
    }
    Ok((jar, version.to_owned()))
}

async fn capture_logs(
    stdout: impl AsyncRead + Unpin,
    stderr: impl AsyncRead + Unpin,
    events: &Channel<StreamEvent>,
) {
    tokio::join!(emit_logs(stdout, events), emit_logs(stderr, events));
    std::future::pending::<()>().await;
}

async fn emit_logs(mut source: impl AsyncRead + Unpin, events: &Channel<StreamEvent>) {
    let mut buffer = [0; 4096];
    while let Ok(size @ 1..) = source.read(&mut buffer).await {
        for line in String::from_utf8_lossy(&buffer[..size]).lines() {
            let _ = events.send(StreamEvent::Log(line.to_owned()));
        }
    }
}

async fn connect_to_video(port: u16) -> Result<TcpStream, String> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(Ok(mut video)) = timeout(
            Duration::from_secs(1),
            TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        {
            let mut dummy = [1];
            if let Ok(Ok(_)) = timeout(Duration::from_secs(1), video.read_exact(&mut dummy)).await {
                if dummy == [0] {
                    return Ok(video);
                }
            }
        }
        sleep(Duration::from_millis(120)).await;
    }
    Err("Could not connect to the Android capture server.".into())
}

async fn stream_sockets(
    port: u16,
    inputs: &InputQueue,
    credits: &FrameCredits,
    frames: &Channel<Response>,
    events: &Channel<StreamEvent>,
    ready: &mut Option<oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let mut video = connect_to_video(port).await?;
    let control = timeout(
        Duration::from_secs(3),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map_err(|_| "Android's input connection timed out.".to_string())?
    .map_err(|e| format!("Could not connect Android input: {e}"))?;
    control.set_nodelay(true).map_err(|e| e.to_string())?;

    let device_name = timeout(
        Duration::from_secs(6),
        read_stream_start(&mut video, events),
    )
    .await
    .map_err(|_| "Android did not send any video metadata.".to_string())??;
    if let Some(ready) = ready.take() {
        let _ = ready.send(Ok(()));
    }

    let (mut control_read, control_write) = control.into_split();
    let mut discarded_messages = tokio::io::sink();
    tokio::select! {
        result = stream_frames(video, &device_name, credits, frames, events) => result,
        result = inputs.write(control_write) => result,
        result = tokio::io::copy(&mut control_read, &mut discarded_messages) => {
            result.map_err(|e| format!("Android input disconnected: {e}"))?;
            Err("Android input disconnected.".into())
        }
    }
}

async fn read_stream_start(
    video: &mut TcpStream,
    events: &Channel<StreamEvent>,
) -> Result<String, String> {
    let mut metadata = [0; 68];
    video.read_exact(&mut metadata).await.map_err(video_error)?;
    if &metadata[64..] != b"h264" {
        return Err("The Android device did not start its H.264 encoder.".into());
    }
    let len = metadata[..64].iter().position(|b| *b == 0).unwrap_or(64);
    let device_name = String::from_utf8_lossy(&metadata[..len]).into_owned();
    let mut header = [0; 12];
    video.read_exact(&mut header).await.map_err(video_error)?;
    if read_u64(&header[..8]) & SESSION_FLAG == 0 {
        return Err("Android did not send a video session header.".into());
    }
    send_dimensions(&device_name, &header, events)?;
    Ok(device_name)
}

fn send_dimensions(
    device_name: &str,
    header: &[u8; 12],
    events: &Channel<StreamEvent>,
) -> Result<(), String> {
    let width = read_u32(&header[4..8]);
    let height = read_u32(&header[8..]);
    if width == 0 || height == 0 || width > u32::from(u16::MAX) || height > u32::from(u16::MAX) {
        return Err("Android reported an invalid screen size.".into());
    }
    events
        .send(StreamEvent::Meta(StreamMeta {
            device_name: device_name.to_owned(),
            codec: "h264",
            width,
            height,
        }))
        .map_err(|e| e.to_string())
}

async fn stream_frames(
    mut video: impl AsyncRead + Unpin,
    device_name: &str,
    credits: &FrameCredits,
    frames: &Channel<Response>,
    events: &Channel<StreamEvent>,
) -> Result<(), String> {
    loop {
        let mut header = [0; 12];
        video.read_exact(&mut header).await.map_err(video_error)?;
        let pts_flags = read_u64(&header[..8]);
        if pts_flags & SESSION_FLAG != 0 {
            send_dimensions(device_name, &header, events)?;
            continue;
        }
        let size = read_u32(&header[8..]) as usize;
        if !(1..=MAX_PACKET_BYTES).contains(&size) {
            return Err("Android sent an invalid video packet length.".into());
        }
        let config = pts_flags & CONFIG_FLAG != 0;
        let key = pts_flags & KEY_FLAG != 0;
        let pts = if config {
            0
        } else {
            pts_flags & (KEY_FLAG - 1)
        };
        let mut bytes = vec![0; 9 + size];
        bytes[0] = u8::from(config) | (u8::from(key) << 1);
        bytes[1..9].copy_from_slice(&pts.to_be_bytes());
        video
            .read_exact(&mut bytes[9..])
            .await
            .map_err(video_error)?;
        credits.send(frames, bytes).await?;
    }
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes.try_into().expect("four header bytes"))
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_be_bytes(bytes.try_into().expect("eight header bytes"))
}

fn video_error(error: io::Error) -> String {
    format!("Android video disconnected: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_messages_match_scrcpy_wire_format() {
        let touch = encode_touch(0, 5, 100., 200., 1080, 2400).unwrap();
        assert_eq!(touch.bytes[..2], [2, 0]);
        assert_eq!(read_u64(&touch.bytes[2..10]), 5);
        assert_eq!(read_u32(&touch.bytes[10..14]), 100);
        assert_eq!(read_u32(&touch.bytes[14..18]), 200);
        assert_eq!(touch.bytes[18..24], [0x04, 0x38, 0x09, 0x60, 0xff, 0xff]);
        assert_eq!(
            encode_touch(1, 0, -10., 9999., 4, 3).unwrap().bytes[14..24],
            [0, 0, 0, 2, 0, 4, 0, 3, 0, 0]
        );
        let key = encode_keypress(4);
        assert_eq!(key.len, 28);
        assert_eq!(key.bytes[..6], [0, 0, 0, 0, 0, 4]);
        assert_eq!(key.bytes[14..20], [0, 1, 0, 0, 0, 4]);
    }

    #[test]
    fn adjacent_moves_coalesce_without_losing_touch_transitions() {
        let queue = InputQueue::default();
        for (action, x) in [(0, 1.), (2, 2.), (2, 3.), (1, 4.)] {
            assert!(queue.push(encode_touch(action, 1, x, 0., 8, 8).unwrap()));
        }
        let messages: Vec<_> = std::iter::from_fn(|| queue.pop()).collect();
        assert_eq!(
            messages.iter().map(|m| m.bytes[1]).collect::<Vec<_>>(),
            [0, 2, 1]
        );
        assert_eq!(read_u32(&messages[1].bytes[10..14]), 3);
    }

    #[tokio::test]
    async fn frames_reach_the_tauri_channel_as_binary_with_flags_and_timestamp() {
        use tauri::ipc::InvokeResponseBody;

        let received = Arc::new(Mutex::new(Vec::new()));
        let received_by_callback = received.clone();
        let frames = Channel::new(move |body| {
            let InvokeResponseBody::Raw(data) = body else {
                panic!("video must stay binary");
            };
            received_by_callback.lock().unwrap().push(data);
            Ok(())
        });
        let credits = FrameCredits::new(frames.id());
        let events = Channel::new(|_| Ok(()));
        let mut input = Vec::new();
        for (flags, packet) in [(CONFIG_FLAG, [0x67, 1]), (KEY_FLAG | 16_666, [0x65, 2])] {
            input.extend(flags.to_be_bytes());
            input.extend((packet.len() as u32).to_be_bytes());
            input.extend(packet);
        }

        // EOF after the two packets models the device closing its socket.
        assert!(
            stream_frames(input.as_slice(), "Pixel test", &credits, &frames, &events)
                .await
                .is_err()
        );
        let frames = received.lock().unwrap();
        assert_eq!(frames[0], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0x67, 1]);
        assert_eq!(frames[1][0], 2);
        assert_eq!(read_u64(&frames[1][1..9]), 16_666);
        assert_eq!(&frames[1][9..], [0x65, 2]);
    }
}
