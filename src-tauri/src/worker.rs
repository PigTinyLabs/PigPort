use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;

#[derive(Default)]
struct Pending {
    calls: HashMap<u64, oneshot::Sender<Reply>>,
    dialogs: HashSet<u64>,
    closed: bool,
}

struct Ipc {
    input: Mutex<ChildStdin>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
}

pub struct Worker {
    ipc: Arc<Ipc>,
    process: Mutex<Child>,
    pub resources: PathBuf,
}

impl Worker {
    pub fn launch(app: &AppHandle) -> Result<Self, String> {
        let data = app
            .path()
            .data_dir()
            .map_err(|error| error.to_string())?
            .join("PlayBridge");
        Self::launch_as(app, "pigport-worker", data)
    }

    pub fn launch_as(app: &AppHandle, name: &str, data: PathBuf) -> Result<Self, String> {
        let (executable, resources) = locations(app, name)?;
        let mut command = Command::new(&executable);
        command
            .env("PIGPORT_USER_DATA", data)
            .env("PIGPORT_RESOURCES", &resources)
            .env("PIGPORT_VERSION", app.package_info().version.to_string())
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut process = command.spawn().map_err(|error| {
            format!(
                "Could not launch the PigPort helper at {}: {error}",
                executable.display()
            )
        })?;
        let ipc = Arc::new(Ipc {
            input: Mutex::new(process.stdin.take().expect("worker stdin was piped")),
            pending: Mutex::new(Pending::default()),
            next_id: AtomicU64::new(1),
        });
        let output = process.stdout.take().expect("worker stdout was piped");
        let reader = Arc::clone(&ipc);
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                match serde_json::from_str(&line) {
                    Ok(message) => reader.receive(&app, message),
                    Err(error) => eprintln!("Invalid PigPort helper message: {error}"),
                }
            }
            let mut pending = reader.pending.lock().unwrap();
            pending.closed = true;
            for (_, sender) in pending.calls.drain() {
                let _ = sender.send(Err("The PigPort helper closed unexpectedly.".into()));
            }
            pending.dialogs.clear();
        });
        Ok(Self {
            ipc,
            process: Mutex::new(process),
            resources,
        })
    }

    pub async fn call(&self, method: &str, args: Vec<Value>) -> Reply {
        let id = self.ipc.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.ipc.pending.lock().unwrap();
            if pending.closed {
                return Err("The PigPort helper has stopped. Reopen PigPort and try again.".into());
            }
            pending.calls.insert(id, sender);
        }
        if let Err(error) = self
            .ipc
            .send(&json!({ "id": id, "method": method, "args": args }))
        {
            self.ipc.pending.lock().unwrap().calls.remove(&id);
            return Err(error);
        }
        receiver
            .await
            .map_err(|_| "The PigPort helper did not reply.".to_string())?
    }

    pub fn dialog_reply(&self, dialog_id: u64, result: Value) -> Result<(), String> {
        if !self.ipc.pending.lock().unwrap().dialogs.remove(&dialog_id) {
            return Err("This dialog has already closed.".into());
        }
        self.ipc.reply_to_dialog(dialog_id, Ok(result))
    }

    pub fn stop(&self) {
        let mut process = self.process.lock().unwrap();
        let _ = process.kill();
        let _ = process.wait();
    }

    pub fn closed(&self) -> bool {
        self.ipc.pending.lock().unwrap().closed
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Ipc {
    fn send(&self, value: &Value) -> Result<(), String> {
        let mut input = self.input.lock().unwrap();
        serde_json::to_writer(&mut *input, value).map_err(|error| error.to_string())?;
        input.write_all(b"\n").map_err(|error| error.to_string())
    }

    fn reply_to_dialog(&self, id: u64, result: Reply) -> Result<(), String> {
        match result {
            Ok(value) => self.send(&json!({ "dialogId": id, "result": value })),
            Err(error) => self.send(&json!({ "dialogId": id, "error": error })),
        }
    }

    fn receive(self: &Arc<Self>, app: &AppHandle, message: Value) {
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if let Some(sender) = self.pending.lock().unwrap().calls.remove(&id) {
                let result = match message.get("error").and_then(Value::as_str) {
                    Some(error) => Err(error.into()),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = sender.send(result);
            }
        } else if let Some(event) = message.get("event").and_then(Value::as_str) {
            let name = match event {
                "runtime:progress" => "pigport-runtime-progress",
                "airplay:status" => "pigport-airplay-status",
                "ipa:progress" => "ipa-progress",
                _ => return,
            };
            let _ = app.emit_to(
                "main",
                name,
                message.get("payload").cloned().unwrap_or(Value::Null),
            );
        } else if let Some(id) = message.get("dialogId").and_then(Value::as_u64) {
            let options = message.get("options").cloned().unwrap_or(Value::Null);
            match message.get("dialog").and_then(Value::as_str) {
                Some("message") => {
                    self.pending.lock().unwrap().dialogs.insert(id);
                    if let Err(error) = app.emit_to(
                        "main",
                        "pigport-dialog",
                        json!({ "dialogId": id, "options": options }),
                    ) {
                        self.pending.lock().unwrap().dialogs.remove(&id);
                        let _ = self.reply_to_dialog(id, Err(error.to_string()));
                    }
                }
                Some(kind @ ("open" | "save")) => {
                    let save = kind == "save";
                    let ipc = Arc::clone(self);
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = file_dialog(&app, options, save).await;
                        let _ = ipc.reply_to_dialog(id, result);
                    });
                }
                _ => {
                    let _ = self.reply_to_dialog(id, Err("Unknown PigPort dialog.".into()));
                }
            }
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FileOptions {
    title: Option<String>,
    default_path: Option<PathBuf>,
    filters: Vec<FileFilter>,
    properties: Vec<String>,
}

#[derive(Deserialize)]
struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

async fn file_dialog(app: &AppHandle, options: Value, save: bool) -> Reply {
    let options: FileOptions =
        serde_json::from_value(options).map_err(|error| error.to_string())?;
    let folder = options
        .properties
        .iter()
        .any(|value| value == "openDirectory");
    let multiple = options
        .properties
        .iter()
        .any(|value| value == "multiSelections");
    let mut dialog = app.dialog().file();
    if let Some(title) = options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(path) = options.default_path {
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        } else {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                dialog = dialog.set_directory(parent);
            }
            if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                dialog = dialog.set_file_name(name);
            }
        }
    }
    for filter in &options.filters {
        let extensions = filter
            .extensions
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let (sender, receiver) = oneshot::channel();
    if save {
        dialog.save_file(move |value| {
            let _ = sender.send(value.into_iter().collect::<Vec<_>>());
        });
    } else if folder {
        dialog.pick_folder(move |value| {
            let _ = sender.send(value.into_iter().collect::<Vec<_>>());
        });
    } else if multiple {
        dialog.pick_files(move |value| {
            let _ = sender.send(value.unwrap_or_default());
        });
    } else {
        dialog.pick_file(move |value| {
            let _ = sender.send(value.into_iter().collect::<Vec<_>>());
        });
    }
    let paths = receiver
        .await
        .map_err(|_| "File picker closed without a result.".to_string())?;
    let paths = paths
        .into_iter()
        .map(FilePath::into_path)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if save {
        Ok(json!({ "canceled": paths.is_empty(), "filePath": paths.first() }))
    } else {
        Ok(json!({ "canceled": paths.is_empty(), "filePaths": paths }))
    }
}

fn locations(app: &AppHandle, name: &str) -> Result<(PathBuf, PathBuf), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("runtime-assets");
    let executable = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .with_file_name(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_owned()
        });
    let resources = if resource_dir.is_dir() {
        resource_dir
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime-assets")
    };
    Ok((executable, resources))
}
