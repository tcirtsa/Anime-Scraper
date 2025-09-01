use std::path::{Path, PathBuf};
use std::fs::{self};
use serde::{Deserialize, Serialize};
use tauri::{command, State};
use anyhow::Result;
use tracing::{info, warn, error};
use std::io;
use std::collections::HashMap;
use crate::commands::logs::{LogStore, add_log_entry, LogLevel};

#[derive(Debug, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub file_type: String,
    pub is_video: bool,
    pub is_subtitle: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProcessResult {
    pub success: bool,
    pub message: String,
    pub processed_files: Vec<String>,
    pub failed_files: Vec<FileError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileError {
    pub path: String,
    pub error: String,
}

// 文件系统错误类型
#[derive(Debug)]
enum FileSystemError {
    IoError(io::Error),
    DifferentFilesystems,
    TargetExists,
    PermissionDenied,
    SourceNotFound,
    Other(String),
}

impl From<io::Error> for FileSystemError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::PermissionDenied => FileSystemError::PermissionDenied,
            io::ErrorKind::NotFound => FileSystemError::SourceNotFound,
            io::ErrorKind::AlreadyExists => FileSystemError::TargetExists,
            _ => FileSystemError::IoError(error),
        }
    }
}

impl std::fmt::Display for FileSystemError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileSystemError::IoError(e) => write!(f, "IO错误: {}", e),
            FileSystemError::DifferentFilesystems => write!(f, "源文件和目标文件不在同一文件系统上，无法创建硬链接"),
            FileSystemError::TargetExists => write!(f, "目标文件已存在"),
            FileSystemError::PermissionDenied => write!(f, "权限不足，无法创建硬链接"),
            FileSystemError::SourceNotFound => write!(f, "源文件不存在"),
            FileSystemError::Other(s) => write!(f, "{}", s),
        }
    }
}

// 检查两个路径是否在同一文件系统上
fn is_same_filesystem(path1: &Path, path2: &Path) -> Result<bool, FileSystemError> {
    // 在Windows上，检查驱动器号是否相同
    #[cfg(target_os = "windows")]
    {
        if let (Some(p1), Some(p2)) = (path1.components().next(), path2.components().next()) {
            use std::path::Component;
            match (p1, p2) {
                (Component::Prefix(p1), Component::Prefix(p2)) => {
                    return Ok(p1.as_os_str() == p2.as_os_str());
                }
                _ => { return Ok(true); }
            }
        }
        return Ok(true); // 添加默认返回值，处理没有组件的情况
    }
    
    // 在Unix系统上，比较设备ID
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata1 = fs::metadata(path1)?;
        let metadata2 = fs::metadata(path2.parent().unwrap_or(path2))?;
        return Ok(metadata1.dev() == metadata2.dev());
    }
    
    // 默认情况下，假设在同一文件系统
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        Ok(true)
    }
}

// 检查文件权限
fn check_file_permissions(source: &Path, target_parent: &Path) -> Result<(), FileSystemError> {
    // 检查源文件是否存在
    if !source.exists() {
        return Err(FileSystemError::SourceNotFound);
    }
    
    // 检查源文件是否可读
    let _source_metadata = fs::metadata(source)?;
    
    // 检查目标目录是否可写
    if target_parent.exists() {
        let _target_metadata = fs::metadata(target_parent)?;
        
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if target_metadata.permissions().mode() & 0o200 == 0 {
                return Err(FileSystemError::PermissionDenied);
            }
        }
    }
    
    Ok(())
}

#[command]
pub async fn scan_directory(path: String, log_store: State<'_, LogStore>) -> Result<Vec<FileInfo>, String> {
    use walkdir::WalkDir;
    
    info!("扫描目录: {}", path);
    add_log_entry(&log_store, LogLevel::INFO, format!("开始扫描目录: {}", path), Some("文件扫描".to_string()));
    
    let mut files = Vec::new();
    
    for entry in WalkDir::new(&path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| {
            if let Err(err) = &e {
                warn!("扫描目录时跳过条目: {}", err);
            }
            e.ok()
        })
    {
        if entry.file_type().is_file() {
            let path_buf = entry.path().to_path_buf();
            let extension = path_buf
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_lowercase();
            
            let is_video = matches!(extension.as_str(), "mkv" | "mp4" | "avi" | "mov");
            let is_subtitle = matches!(extension.as_str(), "ass" | "srt" | "vtt");
            
            if is_video || is_subtitle {
                match std::fs::metadata(&path_buf) {
                    Ok(metadata) => {
                        files.push(FileInfo {
                            path: path_buf.to_string_lossy().to_string(),
                            name: path_buf.file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string(),
                            size: metadata.len(),
                            file_type: extension,
                            is_video,
                            is_subtitle,
                        });
                    },
                    Err(e) => {
                        warn!("无法获取文件元数据 {}: {}", path_buf.display(), e);
                    }
                }
            }
        }
    }
    
    info!("扫描完成，找到 {} 个文件", files.len());
    add_log_entry(&log_store, LogLevel::INFO, format!("扫描完成，找到 {} 个文件", files.len()), Some("文件扫描".to_string()));
    Ok(files)
}

// 清理文件名中的非法字符
fn sanitize_filename(filename: &str) -> String {
    let mut sanitized = filename.to_string();
    
    // Windows 不支持的字符
    let invalid_chars = ['<', '>', ':', '"', '|', '?', '*'];
    for ch in invalid_chars {
        sanitized = sanitized.replace(ch, "_");
    }
    
    // 替换一些特殊Unicode字符，但保留用于兼容Windows文件名的全角标点
    sanitized = sanitized
        .replace('☆', "★")  // 替换空心星号为实心星号
        .replace('～', "~")  // 替换全角波浪号为半角
        .replace('＆', "&")  // 替换全角&为半角
        .replace('！', "!")  // 替换全角!为半角
        // .replace('？', "?")  // 保留全角问号以兼容文件名
        // .replace('：', ":")  // 保留全角冒号以兼容文件名
        .replace('；', ";")  // 替换全角;为半角
        .replace('，', ",")  // 替换全角,为半角
        .replace('。', ".")  // 替换全角.为半角
        .replace('（', "(")  // 替换全角(为半角
        .replace('）', ")")  // 替换全角)为半角
        .replace('【', "[")  // 替换全角[为半角
        .replace('】', "]")  // 替换全角]为半角
        .replace('｛', "{")  // 替换全角{为半角
        .replace('｝', "}")  // 替换全角}为半角
        .replace('　', " ");  // 替换全角空格为半角空格
    
    // 移除控制字符
    sanitized = sanitized.chars()
        .filter(|c| !c.is_control())
        .collect();
    
    // 移除开头和结尾的空格和点
    sanitized = sanitized.trim_matches(|c: char| c.is_whitespace() || c == '.').to_string();
    
    // 如果文件名为空，使用默认名称
    if sanitized.is_empty() {
        sanitized = "unnamed_file".to_string();
    }
    
    // 限制文件名长度（Windows文件名最大255字符）
    if sanitized.len() > 200 {
        sanitized.truncate(200);
        // 确保不在多字节字符中间截断
        while !sanitized.is_char_boundary(sanitized.len()) {
            sanitized.pop();
        }
    }
    
    sanitized
}

// 清理路径，处理长路径问题
fn sanitize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();
    
    for component in path.components() {
        match component {
            std::path::Component::Normal(name) => {
                let name_str = name.to_string_lossy();
                let sanitized = sanitize_filename(&name_str);
                components.push(sanitized);
            }
            std::path::Component::RootDir => {
                components.push("/".to_string());
            }
            std::path::Component::Prefix(prefix) => {
                components.push(prefix.as_os_str().to_string_lossy().to_string());
            }
            _ => {
                components.push(component.as_os_str().to_string_lossy().to_string());
            }
        }
    }
    
    PathBuf::from(components.join(std::path::MAIN_SEPARATOR_STR))
}

// 创建硬链接的核心函数，包含完整的错误处理
fn create_hard_link_internal(source: &Path, target: &Path) -> Result<(), FileSystemError> {
    info!("创建硬链接: {} -> {}", source.display(), target.display());
    
    // 检查源文件是否存在
    if !source.exists() {
        error!("源文件不存在: {}", source.display());
        return Err(FileSystemError::SourceNotFound);
    }
    
    // 清理目标路径
    let sanitized_target = sanitize_path(target);
    let final_target = &sanitized_target;
    
    info!("清理后的目标路径: {}", final_target.display());
    
    // 检查目标文件是否已存在
    if final_target.exists() {
        warn!("目标文件已存在: {}", final_target.display());
        return Err(FileSystemError::TargetExists);
    }
    
    // 确保目标目录存在
    if let Some(parent) = final_target.parent() {
        if !parent.exists() {
            info!("创建目标目录: {}", parent.display());
            fs::create_dir_all(parent)?;
        }
    }
    
    // 检查源文件和目标文件是否在同一文件系统
    if let Some(target_parent) = final_target.parent() {
        if !is_same_filesystem(source, target_parent)? {
            error!("源文件和目标文件不在同一文件系统上");
            return Err(FileSystemError::DifferentFilesystems);
        }
        
        // 检查文件权限
        check_file_permissions(source, target_parent)?;
    }
    
    // 检查路径长度（Windows路径限制）
    let target_path_str = final_target.to_string_lossy();
    if target_path_str.len() > 260 {
        warn!("目标路径过长 ({} 字符)，尝试使用短路径", target_path_str.len());
        
        // 尝试使用相对路径或缩短路径
        if let Some(parent) = final_target.parent() {
            if let Some(filename) = final_target.file_name() {
                let short_filename = sanitize_filename(&filename.to_string_lossy());
                let short_target = parent.join(short_filename);
                
                if short_target.to_string_lossy().len() <= 260 {
                    return create_hard_link_with_fallback(source, &short_target);
                }
            }
        }
        
        return Err(FileSystemError::Other("目标路径过长".to_string()));
    }
    
    // 创建硬链接
    create_hard_link_with_fallback(source, final_target)
}

// 创建硬链接，包含回退机制
fn create_hard_link_with_fallback(source: &Path, target: &Path) -> Result<(), FileSystemError> {
    match fs::hard_link(source, target) {
        Ok(_) => {
            info!("硬链接创建成功: {} -> {}", source.display(), target.display());
            Ok(())
        }
        Err(e) => {
            error!("硬链接创建失败: {}, 错误: {}", target.display(), e);
            
            // 如果是路径相关错误，尝试复制文件作为回退
            match e.kind() {
                io::ErrorKind::InvalidInput | 
                io::ErrorKind::InvalidData => {
                    warn!("硬链接失败，尝试复制文件作为回退");
                    match fs::copy(source, target) {
                        Ok(_) => {
                            info!("文件复制成功: {} -> {}", source.display(), target.display());
                            Ok(())
                        }
                        Err(copy_err) => {
                            error!("文件复制也失败: {}", copy_err);
                            Err(FileSystemError::IoError(copy_err))
                        }
                    }
                }
                _ => Err(FileSystemError::IoError(e))
            }
        }
    }
}

#[command]
pub async fn create_hard_link(source: String, target: String, log_store: State<'_, LogStore>) -> Result<bool, String> {
    let source_path = PathBuf::from(&source);
    let target_path = PathBuf::from(&target);
    
    add_log_entry(&log_store, LogLevel::INFO, format!("开始创建硬链接: {} -> {}", source, target), Some("硬链接创建".to_string()));
    
    match create_hard_link_internal(&source_path, &target_path) {
        Ok(_) => {
            info!("硬链接创建成功: {} -> {}", source, target);
            add_log_entry(&log_store, LogLevel::INFO, format!("硬链接创建成功: {} -> {}", source, target), Some("硬链接创建".to_string()));
            Ok(true)
        },
        Err(e) => {
            error!("硬链接创建失败: {} -> {}, 错误: {}", source, target, e);
            add_log_entry(&log_store, LogLevel::ERROR, format!("硬链接创建失败: {} -> {}, 错误: {}", source, target, e), Some("硬链接创建".to_string()));
            Err(e.to_string())
        }
    }
}

#[command]
pub async fn batch_process_files(files: Vec<String>, output_dir: String, log_store: State<'_, LogStore>) -> Result<ProcessResult, String> {
    use rayon::prelude::*;
    use std::sync::{Arc, Mutex};
    
    info!("开始批量处理 {} 个文件到目录: {}", files.len(), output_dir);
    add_log_entry(&log_store, LogLevel::INFO, format!("开始批量处理 {} 个文件到目录: {}", files.len(), output_dir), Some("批量处理".to_string()));
    
    // 清理输出目录路径
    let sanitized_output_dir = sanitize_path(&PathBuf::from(&output_dir));
    
    // 创建输出目录（如果不存在）
    if !sanitized_output_dir.exists() {
        if let Err(e) = fs::create_dir_all(&sanitized_output_dir) {
            error!("创建输出目录失败: {}", e);
            return Err(format!("创建输出目录失败: {}", e));
        }
    }
    
    // 使用线程安全的容器收集结果
    let processed_files = Arc::new(Mutex::new(Vec::new()));
    let failed_files = Arc::new(Mutex::new(Vec::new()));
    
    // 并行处理文件
    files.par_iter().for_each(|file_path| {
        let source = PathBuf::from(file_path);
        
        // 获取文件名
        match source.file_name() {
            Some(file_name) => {
                let sanitized_filename = sanitize_filename(&file_name.to_string_lossy());
                let target = sanitized_output_dir.join(&sanitized_filename);
                
                // 检查目标路径长度
                let target_path_str = target.to_string_lossy();
                if target_path_str.len() > 260 {
                    warn!("目标路径过长: {} ({} 字符)", target_path_str, target_path_str.len());
                    
                    // 尝试缩短文件名
                    if let Some(file_stem) = target.file_stem() {
                        if let Some(extension) = target.extension() {
                            let short_stem = if file_stem.len() > 100 {
                                let stem_str = file_stem.to_string_lossy();
                                format!("{}...", &stem_str[..97])
                            } else {
                                file_stem.to_string_lossy().to_string()
                            };
                            
                            let short_filename = format!("{}.{}", short_stem, extension.to_string_lossy());
                            let short_target = sanitized_output_dir.join(short_filename);
                            
                            if short_target.to_string_lossy().len() <= 260 {
                                match create_hard_link_internal(&source, &short_target) {
                                    Ok(_) => {
                                        let mut processed = processed_files.lock().unwrap();
                                        processed.push(file_path.clone());
                                        return;
                                    },
                                    Err(e) => {
                                        let mut failed = failed_files.lock().unwrap();
                                        failed.push(FileError {
                                            path: file_path.clone(),
                                            error: format!("路径过长且缩短后仍失败: {}", e),
                                        });
                                        warn!("文件处理失败 (路径过长): {}, 错误: {}", file_path, e);
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    
                    // 如果缩短后仍然过长，记录错误
                    let mut failed = failed_files.lock().unwrap();
                    failed.push(FileError {
                        path: file_path.clone(),
                        error: format!("目标路径过长: {} 字符", target_path_str.len()),
                    });
                    warn!("目标路径过长，无法处理: {}", file_path);
                    return;
                }
                
                // 尝试创建硬链接
                match create_hard_link_internal(&source, &target) {
                    Ok(_) => {
                        // 成功处理
                        let mut processed = processed_files.lock().unwrap();
                        processed.push(file_path.clone());
                    },
                    Err(e) => {
                        // 处理失败
                        let mut failed = failed_files.lock().unwrap();
                        failed.push(FileError {
                            path: file_path.clone(),
                            error: e.to_string(),
                        });
                        
                        warn!("文件处理失败: {}, 错误: {}", file_path, e);
                    }
                }
            },
            None => {
                // 无效的文件名
                let mut failed = failed_files.lock().unwrap();
                failed.push(FileError {
                    path: file_path.clone(),
                    error: "无效的文件名".to_string(),
                });
                
                warn!("无效的文件名: {}", file_path);
            }
        }
    });
    
    // 获取处理结果
    let processed = Arc::try_unwrap(processed_files)
        .unwrap()
        .into_inner()
        .unwrap();
    
    let failed = Arc::try_unwrap(failed_files)
        .unwrap()
        .into_inner()
        .unwrap();
    
    let success_count = processed.len();
    let failed_count = failed.len();
    let total_count = files.len();
    
    info!("批量处理完成: 成功 {}, 失败 {}, 总计 {}", success_count, failed_count, total_count);
    add_log_entry(&log_store, LogLevel::INFO, format!("批量处理完成: 成功 {}, 失败 {}, 总计 {}", success_count, failed_count, total_count), Some("批量处理".to_string()));
    
    // 如果有失败的文件，输出详细信息
    if failed_count > 0 {
        error!("处理失败的文件详情:");
        add_log_entry(&log_store, LogLevel::WARN, format!("批量处理中有 {} 个文件失败", failed_count), Some("批量处理".to_string()));
        for failed_file in &failed {
            error!("  - {}: {}", failed_file.path, failed_file.error);
            add_log_entry(&log_store, LogLevel::ERROR, format!("文件处理失败: {} - {}", failed_file.path, failed_file.error), Some("批量处理".to_string()));
        }
    }
    
    Ok(ProcessResult {
        success: failed_count == 0,
        message: format!("处理完成: 成功 {}/{}, 失败 {}", success_count, total_count, failed_count),
        processed_files: processed,
        failed_files: failed,
    })
}

// 检查文件是否可以被硬链接（预检查）
#[command]
pub async fn check_hardlink_capability(source_dir: String, target_dir: String) -> Result<bool, String> {
    let source_path = PathBuf::from(&source_dir);
    let target_path = PathBuf::from(&target_dir);
    
    if !source_path.exists() {
        return Err("源目录不存在".to_string());
    }
    
    // 确保目标目录存在
    if !target_path.exists() {
        if let Err(e) = fs::create_dir_all(&target_path) {
            return Err(format!("无法创建目标目录: {}", e));
        }
    }
    
    // 检查是否在同一文件系统
    match is_same_filesystem(&source_path, &target_path) {
        Ok(same) => {
            if !same {
                return Err("源目录和目标目录不在同一文件系统上，无法创建硬链接".to_string());
            }
        },
        Err(e) => {
            return Err(format!("检查文件系统失败: {}", e));
        }
    }
    
    // 检查权限
    match check_file_permissions(&source_path, &target_path) {
        Ok(_) => {},
        Err(e) => {
            return Err(format!("权限检查失败: {}", e));
        }
    }
    
    Ok(true)
}

// 获取文件系统信息
#[command]
pub async fn get_filesystem_info(path: String) -> Result<HashMap<String, String>, String> {
    let path_buf = PathBuf::from(&path);
    let mut info = HashMap::new();
    
    if !path_buf.exists() {
        return Err("路径不存在".to_string());
    }
    
    // 获取基本信息
    match fs::metadata(&path_buf) {
        Ok(metadata) => {
            info.insert("is_dir".to_string(), metadata.is_dir().to_string());
            info.insert("is_file".to_string(), metadata.is_file().to_string());
            info.insert("size".to_string(), metadata.len().to_string());
            
            // 获取修改时间
            if let Ok(modified) = metadata.modified() {
                if let Ok(modified_time) = modified.duration_since(std::time::UNIX_EPOCH) {
                    info.insert("modified".to_string(), modified_time.as_secs().to_string());
                }
            }
            
            // 获取创建时间
            if let Ok(created) = metadata.created() {
                if let Ok(created_time) = created.duration_since(std::time::UNIX_EPOCH) {
                    info.insert("created".to_string(), created_time.as_secs().to_string());
                }
            }
            
            // 获取文件系统特定信息
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                info.insert("device_id".to_string(), metadata.dev().to_string());
                info.insert("inode".to_string(), metadata.ino().to_string());
                info.insert("permissions".to_string(), format!("{:o}", metadata.mode()));
            }
            
            #[cfg(windows)]
            {
                // 获取Windows驱动器信息
                if let Some(root) = path_buf.ancestors().last() {
                    info.insert("drive".to_string(), root.to_string_lossy().to_string());
                }
            }
        },
        Err(e) => {
            return Err(format!("获取文件元数据失败: {}", e));
        }
    }
    
    Ok(info)
}

// 处理文件冲突
#[command]
pub async fn handle_file_conflict(
    source: String,
    target: String,
    strategy: String
) -> Result<bool, String> {
    let source_path = PathBuf::from(&source);
    let target_path = PathBuf::from(&target);
    
    if !target_path.exists() {
        // 如果目标文件不存在，则不存在冲突
        return Ok(false);
    }
    
    match strategy.as_str() {
        "skip" => {
            // 跳过此文件
            info!("跳过已存在的文件: {}", target_path.display());
            Ok(true)
        },
        "overwrite" => {
            // 覆盖目标文件
            info!("覆盖已存在的文件: {}", target_path.display());
            if let Err(e) = fs::remove_file(&target_path) {
                error!("删除已存在的文件失败: {}", e);
                return Err(format!("删除已存在的文件失败: {}", e));
            }
            
            // 创建硬链接
            match create_hard_link_internal(&source_path, &target_path) {
                Ok(_) => Ok(true),
                Err(e) => Err(e.to_string())
            }
        },
        "rename" => {
            // 自动重命名目标文件
            let file_stem = target_path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("file");
            
            let extension = target_path.extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            
            // 生成新的文件名 (name_1.ext, name_2.ext, ...)
            let mut counter = 1;
            let mut new_target_path;
            
            loop {
                let new_name = if extension.is_empty() {
                    format!("{}_{}", file_stem, counter)
                } else {
                    format!("{}_{}.{}", file_stem, counter, extension)
                };
                
                new_target_path = target_path.with_file_name(new_name);
                
                if !new_target_path.exists() {
                    break;
                }
                
                counter += 1;
                if counter > 100 {
                    // 防止无限循环
                    return Err("无法生成唯一的文件名".to_string());
                }
            }
            
            info!("重命名目标文件: {} -> {}", target_path.display(), new_target_path.display());
            
            // 创建硬链接
            match create_hard_link_internal(&source_path, &new_target_path) {
                Ok(_) => Ok(true),
                Err(e) => Err(e.to_string())
            }
        },
        _ => Err(format!("不支持的冲突处理策略: {}", strategy))
    }
}

// 检查路径是否为目录
#[command]
pub async fn is_directory(path: String) -> Result<bool, String> {
    let path_buf = PathBuf::from(&path);
    match fs::metadata(&path_buf) {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(e) => Err(format!("无法获取路径信息: {}", e))
    }
}

// 获取单个文件信息
#[command]
pub async fn get_file_info(path: String) -> Result<FileInfo, String> {
    let path_buf = PathBuf::from(&path);
    
    if !path_buf.exists() {
        return Err("文件不存在".to_string());
    }
    
    let metadata = fs::metadata(&path_buf)
        .map_err(|e| format!("无法获取文件元数据: {}", e))?;
    
    if metadata.is_dir() {
        return Err("路径是目录，不是文件".to_string());
    }
    
    let file_name = path_buf.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string();
    
    let extension = path_buf.extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    let is_video = matches!(extension.as_str(), "mkv" | "mp4" | "avi" | "mov");
    let is_subtitle = matches!(extension.as_str(), "ass" | "srt" | "vtt");
    
    if !is_video && !is_subtitle {
        return Err("不支持的文件类型".to_string());
    }
    
    Ok(FileInfo {
        path: path_buf.to_string_lossy().to_string(),
        name: file_name,
        size: metadata.len(),
        file_type: extension,
        is_video,
        is_subtitle,
    })
}

// 测试路径清理功能
#[command]
pub async fn test_path_sanitization(paths: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::new();
    
    for path in paths {
        let original_path = PathBuf::from(&path);
        let sanitized_path = sanitize_path(&original_path);
        result.insert(path, sanitized_path.to_string_lossy().to_string());
    }
    
    Ok(result)
}

// 预览文件处理结果
#[command]
pub async fn preview_file_processing(
    files: Vec<String>, 
    output_dir: String,
    rename_map: HashMap<String, String>
) -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::new();
    let sanitized_output_dir = sanitize_path(&PathBuf::from(&output_dir));
    
    for file_path in files {
        let source = PathBuf::from(&file_path);
        
        // 获取新文件名（如果存在）
        let target_filename = match rename_map.get(&file_path) {
            Some(new_name) => {
                let cleaned_name = new_name.replace('\\', "/");
                if cleaned_name.contains('/') {
                    let parts: Vec<String> = cleaned_name.split('/')
                        .map(|part| sanitize_filename(part))
                        .collect();
                    parts.join("/")
                } else {
                    sanitize_filename(&cleaned_name)
                }
            },
            None => {
                match source.file_name() {
                    Some(name) => sanitize_filename(&name.to_string_lossy()),
                    None => "invalid_filename".to_string(),
                }
            }
        };
        
        let target = sanitized_output_dir.join(&target_filename);
        result.insert(file_path, target.to_string_lossy().to_string());
    }
    
    Ok(result)
}

// 添加新的批量处理函数，支持自定义命名和季度文件夹
// 生成季度文件夹名称
fn generate_season_folder_name(template: &str, season: u32) -> String {
    let mut folder_name = template.to_string();
    folder_name = folder_name.replace("{season}", &season.to_string());
    folder_name = folder_name.replace("{season:02}", &format!("{:02}", season));
    folder_name = folder_name.replace("{season:03}", &format!("{:03}", season));
    
    // 清理文件夹名称
    sanitize_filename(&folder_name)
}

// 新的批量处理函数，支持季度文件夹
#[command]
pub async fn batch_process_with_season_folders(
    files: Vec<String>, 
    output_dir: String,
    rename_map: HashMap<String, String>,
    create_season_folders: bool,
    season_folder_template: String,
    log_store: State<'_, LogStore>
) -> Result<ProcessResult, String> {
    use rayon::prelude::*;
    use std::sync::{Arc, Mutex};
    
    info!("开始批量处理文件，季度文件夹: {}, 模板: {}", create_season_folders, season_folder_template);
    add_log_entry(&log_store, LogLevel::INFO, format!("开始批量处理文件，季度文件夹: {}, 模板: {}", create_season_folders, season_folder_template), Some("季度文件夹处理".to_string()));
    
    // 清理输出目录路径
    let sanitized_output_dir = sanitize_path(&PathBuf::from(&output_dir));
    
    // 创建输出目录（如果不存在）
    if !sanitized_output_dir.exists() {
        if let Err(e) = fs::create_dir_all(&sanitized_output_dir) {
            error!("创建输出目录失败: {}", e);
            return Err(format!("创建输出目录失败: {}", e));
        }
    }
    
    // 使用线程安全的容器收集结果
    let processed_files = Arc::new(Mutex::new(Vec::new()));
    let failed_files = Arc::new(Mutex::new(Vec::new()));
    
    // 并行处理文件
    files.par_iter().for_each(|file_path| {
        let source = PathBuf::from(file_path);
        
        // 获取新文件名（如果存在）
        let target_filename = match rename_map.get(file_path) {
            Some(new_name) => {
                let cleaned_name = new_name.replace('\\', "/");
                if cleaned_name.contains('/') {
                    let parts: Vec<String> = cleaned_name.split('/')
                        .map(|part| sanitize_filename(part))
                        .collect();
                    parts.join("/")
                } else {
                    sanitize_filename(&cleaned_name)
                }
            },
            None => {
                match source.file_name() {
                    Some(name) => sanitize_filename(&name.to_string_lossy()),
                    None => {
                        let mut failed = failed_files.lock().unwrap();
                        failed.push(FileError {
                            path: file_path.clone(),
                            error: "无效的文件名".to_string(),
                        });
                        warn!("无效的文件名: {}", file_path);
                        return;
                    }
                }
            }
        };
        
        // 构建目标路径，处理季度文件夹
        let target = if target_filename.contains('/') {
            // 解析路径结构：动漫名/季度/文件名 或 动漫名/文件名
            let path_parts: Vec<&str> = target_filename.split('/').collect();
            if path_parts.len() >= 2 {
                let anime_name = path_parts[0];
                
                // 检查是否需要创建季度文件夹
                if create_season_folders && path_parts.len() >= 3 {
                    // 有季度信息且需要创建季度文件夹
                    let season_info = path_parts[1];
                    let file_name = path_parts.last().unwrap();
                    
                    // 尝试从路径中提取季度信息
                    let season_number = extract_season_from_path(season_info);
                    
                    // 勾选时，为所有季度（包括第1季）都创建季度子文件夹
                    let season_folder = generate_season_folder_name(&season_folder_template, season_number);
                    let full_path = format!("{}/{}/{}", anime_name, season_folder, file_name);
                    sanitized_output_dir.join(full_path)
                } else {
                    // 不创建季度文件夹，直接使用动漫文件夹
                    let file_name = path_parts.last().unwrap();
                    let full_path = format!("{}/{}", anime_name, file_name);
                    sanitized_output_dir.join(full_path)
                }
            } else {
                sanitized_output_dir.join(&target_filename)
            }
        } else {
            sanitized_output_dir.join(&target_filename)
        };
        
        // 确保目标目录存在
        if let Some(parent) = target.parent() {
            if !parent.exists() {
                if let Err(e) = fs::create_dir_all(parent) {
                    let mut failed = failed_files.lock().unwrap();
                    failed.push(FileError {
                        path: file_path.clone(),
                        error: format!("创建目录失败: {}", e),
                    });
                    warn!("创建目录失败: {}, 错误: {}", parent.display(), e);
                    return;
                }
            }
        }
        
        // 检查目标路径长度
        let target_path_str = target.to_string_lossy();
        if target_path_str.len() > 260 {
            warn!("目标路径过长: {} ({} 字符)", target_path_str, target_path_str.len());
            let mut failed = failed_files.lock().unwrap();
            failed.push(FileError {
                path: file_path.clone(),
                error: format!("目标路径过长: {} 字符", target_path_str.len()),
            });
            return;
        }
        
        // 尝试创建硬链接
        match create_hard_link_internal(&source, &target) {
            Ok(_) => {
                let mut processed = processed_files.lock().unwrap();
                processed.push(file_path.clone());
                info!("文件处理成功: {} -> {}", file_path, target.display());
            },
            Err(e) => {
                let mut failed = failed_files.lock().unwrap();
                failed.push(FileError {
                    path: file_path.clone(),
                    error: e.to_string(),
                });
                warn!("文件处理失败: {}, 错误: {}", file_path, e);
            }
        }
    });
    
    // 获取处理结果
    let processed = Arc::try_unwrap(processed_files)
        .unwrap()
        .into_inner()
        .unwrap();
    
    let failed = Arc::try_unwrap(failed_files)
        .unwrap()
        .into_inner()
        .unwrap();
    
    let success_count = processed.len();
    let failed_count = failed.len();
    let total_count = files.len();
    
    info!("批量处理完成: 成功 {}, 失败 {}, 总计 {}", success_count, failed_count, total_count);
    add_log_entry(&log_store, LogLevel::INFO, format!("季度文件夹处理完成: 成功 {}, 失败 {}, 总计 {}", success_count, failed_count, total_count), Some("季度文件夹处理".to_string()));
    
    if failed_count > 0 {
        add_log_entry(&log_store, LogLevel::WARN, format!("季度文件夹处理中有 {} 个文件失败", failed_count), Some("季度文件夹处理".to_string()));
    }
    
    Ok(ProcessResult {
        success: failed_count == 0,
        message: format!("处理完成: 成功 {}/{}, 失败 {}", success_count, total_count, failed_count),
        processed_files: processed,
        failed_files: failed,
    })
}

// 从路径中提取季度信息
fn extract_season_from_path(path_part: &str) -> u32 {
    // 尝试从路径部分提取季度数字
    let season_patterns = [
        r"Season\s*(\d+)",
        r"S(\d+)",
        r"第(\d+)季",
        r"season\s*(\d+)",
        r"s(\d+)",
    ];
    
    for pattern in &season_patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(captures) = re.captures(path_part) {
                if let Some(season_match) = captures.get(1) {
                    if let Ok(season) = season_match.as_str().parse::<u32>() {
                        return season;
                    }
                }
            }
        }
    }
    
    // 如果无法提取，默认返回1
    1
}

#[command]
pub async fn batch_process_with_rename(
    files: Vec<String>, 
    output_dir: String,
    rename_map: HashMap<String, String>,
    log_store: State<'_, LogStore>
) -> Result<ProcessResult, String> {
    use rayon::prelude::*;
    use std::sync::{Arc, Mutex};
    
    info!("开始批量处理并重命名 {} 个文件到目录: {}", files.len(), output_dir);
    add_log_entry(&log_store, LogLevel::INFO, format!("开始批量处理并重命名 {} 个文件到目录: {}", files.len(), output_dir), Some("批量重命名".to_string()));
    
    // 清理输出目录路径
    let sanitized_output_dir = sanitize_path(&PathBuf::from(&output_dir));
    
    // 创建输出目录（如果不存在）
    if !sanitized_output_dir.exists() {
        if let Err(e) = fs::create_dir_all(&sanitized_output_dir) {
            error!("创建输出目录失败: {}", e);
            return Err(format!("创建输出目录失败: {}", e));
        }
    }
    
    // 使用线程安全的容器收集结果
    let processed_files = Arc::new(Mutex::new(Vec::new()));
    let failed_files = Arc::new(Mutex::new(Vec::new()));
    
    // 并行处理文件
    files.par_iter().for_each(|file_path| {
        let source = PathBuf::from(file_path);
        
        // 获取新文件名（如果存在）
        let target_filename = match rename_map.get(file_path) {
            Some(new_name) => {
                // 清理文件名中的路径分隔符，确保是单个文件名或相对路径
                let cleaned_name = new_name.replace('\\', "/");
                if cleaned_name.contains('/') {
                    // 如果包含路径分隔符，需要分别清理每个部分
                    let parts: Vec<String> = cleaned_name.split('/')
                        .map(|part| sanitize_filename(part))
                        .collect();
                    parts.join("/")
                } else {
                    sanitize_filename(&cleaned_name)
                }
            },
            None => {
                // 如果没有提供新名称，使用原始文件名
                match source.file_name() {
                    Some(name) => sanitize_filename(&name.to_string_lossy()),
                    None => {
                        // 无效的文件名
                        let mut failed = failed_files.lock().unwrap();
                        failed.push(FileError {
                            path: file_path.clone(),
                            error: "无效的文件名".to_string(),
                        });
                        
                        warn!("无效的文件名: {}", file_path);
                        return;
                    }
                }
            }
        };
        
        // 构建目标路径 - 这里需要处理季度文件夹的嵌套结构
        let target = if target_filename.contains('/') {
            // 如果目标文件名包含路径分隔符，说明需要创建子目录结构
            sanitized_output_dir.join(&target_filename)
        } else {
            sanitized_output_dir.join(&target_filename)
        };
        
        // 检查目标路径长度
        let target_path_str = target.to_string_lossy();
        if target_path_str.len() > 260 {
            warn!("目标路径过长: {} ({} 字符)", target_path_str, target_path_str.len());
            
            // 尝试缩短文件名
            if let Some(file_stem) = target.file_stem() {
                if let Some(extension) = target.extension() {
                    let short_stem = if file_stem.len() > 100 {
                        let stem_str = file_stem.to_string_lossy();
                        format!("{}...", &stem_str[..97])
                    } else {
                        file_stem.to_string_lossy().to_string()
                    };
                    
                    let short_filename = format!("{}.{}", short_stem, extension.to_string_lossy());
                    let short_target = sanitized_output_dir.join(short_filename);
                    
                    if short_target.to_string_lossy().len() <= 260 {
                        match create_hard_link_internal(&source, &short_target) {
                            Ok(_) => {
                                let mut processed = processed_files.lock().unwrap();
                                processed.push(file_path.clone());
                                return;
                            },
                            Err(e) => {
                                let mut failed = failed_files.lock().unwrap();
                                failed.push(FileError {
                                    path: file_path.clone(),
                                    error: format!("路径过长且缩短后仍失败: {}", e),
                                });
                                warn!("文件处理失败 (路径过长): {}, 错误: {}", file_path, e);
                                return;
                            }
                        }
                    }
                }
            }
            
            // 如果缩短后仍然过长，记录错误
            let mut failed = failed_files.lock().unwrap();
            failed.push(FileError {
                path: file_path.clone(),
                error: format!("目标路径过长: {} 字符", target_path_str.len()),
            });
            warn!("目标路径过长，无法处理: {}", file_path);
            return;
        }
        
        // 尝试创建硬链接
        match create_hard_link_internal(&source, &target) {
            Ok(_) => {
                // 成功处理
                let mut processed = processed_files.lock().unwrap();
                processed.push(file_path.clone());
            },
            Err(e) => {
                // 处理失败
                let mut failed = failed_files.lock().unwrap();
                failed.push(FileError {
                    path: file_path.clone(),
                    error: e.to_string(),
                });
                
                warn!("文件处理失败: {}, 错误: {}", file_path, e);
            }
        }
    });
    
    // 获取处理结果
    let processed = Arc::try_unwrap(processed_files)
        .unwrap()
        .into_inner()
        .unwrap();
    
    let failed = Arc::try_unwrap(failed_files)
        .unwrap()
        .into_inner()
        .unwrap();
    
    let success_count = processed.len();
    let failed_count = failed.len();
    let total_count = files.len();
    
    info!("批量处理完成: 成功 {}, 失败 {}, 总计 {}", success_count, failed_count, total_count);
    add_log_entry(&log_store, LogLevel::INFO, format!("批量重命名完成: 成功 {}, 失败 {}, 总计 {}", success_count, failed_count, total_count), Some("批量重命名".to_string()));
    
    // 如果有失败的文件，输出详细信息
    if failed_count > 0 {
        error!("处理失败的文件详情:");
        add_log_entry(&log_store, LogLevel::WARN, format!("批量重命名中有 {} 个文件失败", failed_count), Some("批量重命名".to_string()));
        for failed_file in &failed {
            error!("  - {}: {}", failed_file.path, failed_file.error);
        }
    }
    
    Ok(ProcessResult {
        success: failed_count == 0,
        message: format!("处理完成: 成功 {}/{}, 失败 {}", success_count, total_count, failed_count),
        processed_files: processed,
        failed_files: failed,
    })
}
