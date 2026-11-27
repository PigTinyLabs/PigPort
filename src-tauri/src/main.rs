#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desktop::run();
}

mod desktop;
mod stream;
mod worker;
