#[path = "../../../src-tauri/src/worker.rs"]
#[allow(dead_code)]
mod worker;

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::{oneshot, Mutex};
use worker::Worker;

#[derive(Default)]
struct Operation(Mutex<()>);

#[tauri::command]
async fn ipa_choose(app: AppHandle) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Chọn tệp IPA")
        .add_filter("IPA", &["ipa"])
        .pick_file(move |file| {
            let _ = sender.send(file);
        });
    receiver
        .await
        .map_err(|_| "Không nhận được kết quả chọn tệp.".to_owned())?
        .map(FilePath::into_path)
        .transpose()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ipa_list(worker: State<'_, Worker>) -> Result<Value, String> {
    worker.call("ipa:list", Vec::new()).await
}

#[tauri::command]
async fn ipa_inspect(worker: State<'_, Worker>, file: PathBuf) -> Result<Value, String> {
    worker.call("ipa:inspect", vec![json!(file)]).await
}

#[tauri::command]
async fn ipa_install(
    worker: State<'_, Worker>,
    operation: State<'_, Operation>,
    file: PathBuf,
) -> Result<Value, String> {
    let _installing = operation
        .0
        .try_lock()
        .map_err(|_| "Đợi quá trình cài đặt hiện tại hoàn tất.")?;
    worker.call("ipa:install", vec![json!(file)]).await
}

#[tauri::command]
async fn ipa_launch(
    worker: State<'_, Worker>,
    operation: State<'_, Operation>,
    app_id: String,
) -> Result<Value, String> {
    let _launching = operation
        .0
        .try_lock()
        .map_err(|_| "Đợi thao tác IPA hiện tại hoàn tất.")?;
    worker.call("ipa:launch", vec![json!(app_id)]).await
}

#[tauri::command]
async fn ipa_reveal(worker: State<'_, Worker>, app_id: String) -> Result<Value, String> {
    worker.call("ipa:reveal", vec![json!(app_id)]).await
}

#[tauri::command]
async fn ipa_store_status(worker: State<'_, Worker>) -> Result<Value, String> {
    worker.call("ipa:storeStatus", Vec::new()).await
}

#[tauri::command]
async fn ipa_store_auth(worker: State<'_, Worker>) -> Result<Value, String> {
    worker.call("ipa:storeAuth", Vec::new()).await
}

#[tauri::command]
async fn ipa_store_search(worker: State<'_, Worker>, query: String) -> Result<Value, String> {
    worker.call("ipa:storeSearch", vec![json!(query)]).await
}

fn ipa_filename(name: &str, app_id: u64) -> String {
    let stem: String = name
        .chars()
        .take(60)
        .map(|character| match character {
            '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*' => '-',
            character if character.is_control() => '-',
            character => character,
        })
        .collect();
    let stem = stem.trim_matches(|character: char| character.is_whitespace() || character == '.');
    if stem.is_empty() {
        format!("{app_id}.ipa")
    } else {
        format!("{stem}.ipa")
    }
}

#[tauri::command]
async fn ipa_store_download(
    app: AppHandle,
    worker: State<'_, Worker>,
    operation: State<'_, Operation>,
    app_id: u64,
    name: String,
) -> Result<Value, String> {
    if app_id == 0 || app_id > 9_007_199_254_740_991 {
        return Err("Mã ứng dụng App Store không hợp lệ.".into());
    }
    let _downloading = operation
        .0
        .try_lock()
        .map_err(|_| "Đợi thao tác IPA hiện tại hoàn tất.")?;

    let (sender, receiver) = oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Lưu tệp IPA")
        .add_filter("IPA", &["ipa"])
        .set_file_name(ipa_filename(&name, app_id));
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    dialog.save_file(move |file| {
        let _ = sender.send(file);
    });
    let Some(file) = receiver
        .await
        .map_err(|_| "Không nhận được vị trí lưu tệp.".to_owned())?
    else {
        return Ok(Value::Null);
    };
    let path = file.into_path().map_err(|error| error.to_string())?;
    worker
        .call("ipa:storeDownload", vec![json!(app_id), json!(path)])
        .await
}

fn operation_pending(app: &AppHandle) -> bool {
    let operation = app.state::<Operation>();
    let busy = operation.0.try_lock().is_err();
    if busy {
        let _ = app.emit_to(
            "main",
            "ipa-progress",
            "Đợi thao tác IPA hoàn tất trước khi đóng PigPort IPA.",
        );
    }
    busy
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Operation::default())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            app.manage(
                Worker::launch_as(app.handle(), "pigport-ipa-worker", data)
                    .map_err(std::io::Error::other)?,
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if operation_pending(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ipa_choose,
            ipa_list,
            ipa_inspect,
            ipa_install,
            ipa_launch,
            ipa_reveal,
            ipa_store_status,
            ipa_store_auth,
            ipa_store_search,
            ipa_store_download
        ])
        .build(tauri::generate_context!())
        .expect("Could not start PigPort IPA")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                if operation_pending(app) {
                    api.prevent_exit();
                }
            }
        });
}
