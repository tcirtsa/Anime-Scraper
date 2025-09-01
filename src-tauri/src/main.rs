#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod commands;

use commands::*;
use commands::logs::create_log_store;

fn main() {
    // 初始化日志系统
    tracing_subscriber::fmt::init();
    
    // 创建日志存储
    let log_store = create_log_store();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(log_store)
        .invoke_handler(tauri::generate_handler![
            // 文件操作命令
            scan_directory,
            create_hard_link,
            batch_process_files,
            batch_process_with_rename,
            batch_process_with_season_folders,
            check_hardlink_capability,
            test_path_sanitization,
            preview_file_processing,
            get_filesystem_info,
            handle_file_conflict,
            is_directory,
            get_file_info,
            // 元数据处理命令
            parse_anime_filename,
            search_anilist,
            generate_filename,
            get_anime_details,
            // 配置管理命令
            load_config,
            save_config,
            reset_config,
            validate_output_directory,
            get_default_directories,
            preview_naming,
            // 日志管理命令
            get_logs,
            clear_logs,
            add_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
