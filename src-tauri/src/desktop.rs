use crate::{
    stream::{StreamEvent, StreamOptions, StreamState},
    worker::Worker,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    ipc::{Channel, Response},
    Emitter, Manager, RunEvent, State, WindowEvent,
};
use tokio::sync::Mutex;

#[derive(Default)]
struct Desktop {
    stream: StreamState,
    android: Mutex<()>,
    exiting: AtomicBool,
}

const METHODS: &[&str] = &[
    "app:info",
    "packages:list",
    "packages:icon",
    "packages:inspect",
    "packages:install",
    "packages:play",
    "packages:uninstall",
    "packages:remove",
    "runtime:status",
    "runtime:android:restart",
    "runtime:android:prepare",
    "runtime:android:install",
    "runtime:android:openGooglePlay",
    "storage:status",
    "storage:choose",
    "settings:get",
    "settings:set",
    "adb:status",
    "adb:devices",
    "adb:wireless",
    "adb:pair",
    "adb:enableWifi",
    "adb:connect",
    "adb:packages",
    "adb:install",
    "adb:uninstall",
    "adb:launch",
    "adb:diagnostics",
    "adb:forceStop",
    "airplay:status",
    "airplay:start",
    "airplay:stop",
    "ios:list",
    "ios:launch",
    "ios:icon",
    "keymap:load",
    "keymap:save",
    "keymap:export",
    "keymap:import",
];

#[tauri::command]
async fn backend_call(
    app: tauri::AppHandle,
    worker: State<'_, Worker>,
    desktop: State<'_, Desktop>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if !METHODS.contains(&method.as_str()) {
        return Err("Unknown PigPort action.".into());
    }
    if desktop.exiting.load(Ordering::Acquire) {
        return Err("PigPort is closing.".into());
    }
    if method == "storage:choose" {
        let _operation = desktop
            .android
            .try_lock()
            .map_err(|_| "Wait for Android to finish connecting before moving storage.")?;
        if desktop.stream.active() {
            return Err("Close the Android player before moving game storage.".into());
        }
        return worker.call(&method, args).await;
    }
    let mut result = worker.call(&method, args).await?;
    if matches!(
        method.as_str(),
        "packages:play" | "adb:launch" | "runtime:android:openGooglePlay"
    ) {
        let pid = result
            .as_object_mut()
            .and_then(|object| object.remove("windowPid"))
            .and_then(|value| value.as_u64())
            .and_then(|pid| u32::try_from(pid).ok());
        if let Some(pid) = pid {
            let _ = app.run_on_main_thread(move || activate_emulator(pid));
        }
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
fn activate_emulator(pid: u32) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationOptions, NSRunningApplication};
    let Some(main) = MainThreadMarker::new() else {
        return;
    };
    let Ok(pid) = i32::try_from(pid) else {
        return;
    };
    let Some(emulator) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else {
        return;
    };
    if emulator.isHidden() {
        emulator.unhide();
    }
    let mut options = NSApplicationActivationOptions::ActivateAllWindows;
    if objc2::available!(macos = 14.0) {
        NSApplication::sharedApplication(main).yieldActivationToApplication(&emulator);
    } else {
        #[allow(deprecated)]
        {
            options |= NSApplicationActivationOptions::ActivateIgnoringOtherApps;
        }
    }
    emulator.activateWithOptions(options);
}

#[cfg(target_os = "windows")]
fn activate_emulator(pid: u32) {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
            SetForegroundWindow, ShowWindowAsync, GW_OWNER, SW_RESTORE,
        },
    };

    unsafe extern "system" fn activate_window(window: HWND, pid: LPARAM) -> BOOL {
        let mut owner_pid = 0;
        GetWindowThreadProcessId(window, &mut owner_pid);
        if owner_pid != pid as u32
            || IsWindowVisible(window) == 0
            || !GetWindow(window, GW_OWNER).is_null()
        {
            return 1;
        }
        if IsIconic(window) != 0 {
            ShowWindowAsync(window, SW_RESTORE);
        }
        SetForegroundWindow(window);
        0
    }

    unsafe { EnumWindows(Some(activate_window), pid as LPARAM) };
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn activate_emulator(_: u32) {}

#[tauri::command]
fn backend_dialog_reply(
    worker: State<'_, Worker>,
    dialog_id: u64,
    result: Value,
) -> Result<(), String> {
    worker.dialog_reply(dialog_id, result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamConfig {
    adb_path: PathBuf,
    options: StreamOptions,
}

#[tauri::command]
async fn stream_start(
    worker: State<'_, Worker>,
    desktop: State<'_, Desktop>,
    serial: String,
    frames: Channel<Response>,
    events: Channel<StreamEvent>,
) -> Result<(), String> {
    if desktop.exiting.load(Ordering::Acquire) {
        return Err("PigPort is closing.".into());
    }
    let _operation = desktop
        .android
        .try_lock()
        .map_err(|_| "Wait for the current Android or storage operation.")?;
    let configuration = worker.call("stream:configuration", Vec::new()).await?;
    let configuration: StreamConfig =
        serde_json::from_value(configuration).map_err(|error| error.to_string())?;
    desktop
        .stream
        .start(
            configuration.adb_path,
            serial,
            worker.resources.clone(),
            configuration.options,
            frames,
            events,
        )
        .await
}

#[tauri::command]
fn stream_stop(desktop: State<'_, Desktop>) {
    desktop.stream.stop();
}

#[tauri::command]
fn stream_ack(desktop: State<'_, Desktop>, channel_id: u32, count: u32) {
    desktop.stream.ack_frames(channel_id, count);
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Input {
    Touch {
        action: u8,
        id: u32,
        x: f64,
        y: f64,
        width: u32,
        height: u32,
    },
    Nav {
        button: String,
    },
}

#[tauri::command]
fn stream_inputs(desktop: State<'_, Desktop>, inputs: Vec<Input>) -> Result<(), String> {
    if inputs.len() > 256 {
        return Err("Too many Android input events.".into());
    }
    for input in inputs {
        match input {
            Input::Touch {
                action,
                id,
                x,
                y,
                width,
                height,
            } => desktop.stream.touch(action, id, x, y, width, height),
            Input::Nav { button } => desktop.stream.nav(&button),
        }
    }
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Desktop::default())
        .setup(|app| {
            app.manage(Worker::launch(app.handle()).map_err(std::io::Error::other)?);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let handle = window.app_handle();
                if cfg!(target_os = "macos") {
                    let desktop = handle.state::<Desktop>();
                    if desktop.android.try_lock().is_err() {
                        return;
                    }
                    desktop.stream.stop();
                    let _ = window.hide();
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle
                            .state::<Worker>()
                            .call("airplay:stop", Vec::new())
                            .await;
                    });
                } else {
                    handle.exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            backend_call,
            backend_dialog_reply,
            stream_start,
            stream_stop,
            stream_ack,
            stream_inputs
        ])
        .build(tauri::generate_context!())
        .expect("Could not start PigPort");
    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = &event
        {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        if let RunEvent::ExitRequested { code, api, .. } = event {
            let desktop = handle.state::<Desktop>();
            if code.is_some() && desktop.exiting.load(Ordering::Acquire) {
                return;
            }
            api.prevent_exit();
            if desktop.exiting.swap(true, Ordering::AcqRel) {
                return;
            }
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let desktop = handle.state::<Desktop>();
                let worker = handle.state::<Worker>();
                desktop.stream.shutdown().await;
                let result = if worker.closed() {
                    Ok(Value::Null)
                } else {
                    worker.call("app:shutdown", Vec::new()).await
                };
                if let Err(error) = result {
                    desktop.exiting.store(false, Ordering::Release);
                    let _ = handle.emit_to("main", "pigport-runtime-progress", error);
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    return;
                }
                worker.stop();
                handle.exit(0);
            });
        }
    });
}
