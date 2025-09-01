import React, { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// Tauri v2 API 可用性检查
const isTauriAvailable = () => {
  return typeof window !== 'undefined' && 
         window.__TAURI_INTERNALS__ !== undefined;
};

const isDialogAvailable = () => {
  // 在 Tauri v2 中，dialog 插件应该是直接可用的
  return typeof window !== 'undefined' && 
         typeof window.__TAURI_INTERNALS__ !== 'undefined';
};

import { bytesToSize } from "../utils/formatters";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { Loader2, X, FileVideo, FileText, FolderOpen, Upload, Search, Info, Edit, Settings, FileMusic, File } from "lucide-react";
import { toast } from "sonner";

interface FileInfo {
  path: string;
  name: string;
  size: number;
  file_type: string;
  is_video: boolean;
  is_subtitle: boolean;
  is_audio: boolean;
  parsed?: ParsedFilename;
  metadata?: AnimeInfo;
  new_name?: string;
}

interface ProcessResult {
  success: boolean;
  message: string;
  processed_files: string[];
  failed_files: FileError[];
}

interface FileError {
  path: string;
  error: string;
}

interface ParsedFilename {
  anime_title: string;
  episode_number?: number;
  season?: number;
  group?: string;
  resolution?: string;
  video_codec?: string;
  audio_codec?: string;
}

interface AnimeInfo {
  id: number;
  title: string;
  title_romaji?: string;
  title_english?: string;
  episode?: number;
  season?: number;
  year?: number;
  quarter?: string;
  format?: string;
  episode_titles?: (string | null)[];
  episode_title?: string;
}

interface AniListResponse {
  id: number;
  title: {
    romaji?: string;
    english?: string;
    native?: string;
  };
  format?: string;
  episodes?: number;
  season_year?: number;
  season?: string;
  start_date?: {
    year?: number;
    month?: number;
  };
  cover_image?: {
    large?: string;
    medium?: string;
  };
}

interface AppConfig {
  output_directory: string;
  naming_template: string;
  folder_template: string;
  season_folder_template: string;
  organize_by_season: boolean;
  create_anime_folders: boolean;
  use_romaji_names: boolean;
  create_season_folders: boolean;
  anilist_enabled: boolean;
  tmdb_enabled: boolean;
  concurrent_limit: number;
  log_level: string;
}

function ImportPage() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [fileNameTemplate, setFileNameTemplate] = useState<string>("{title_romaji} - S{season}E{episode:02}");
  const [folderTemplate, setFolderTemplate] = useState<string>("{title_romaji} ({year})");
  const [seasonFolderTemplate, setSeasonFolderTemplate] = useState<string>("Season {season}");
  const [selectedAnimeId, setSelectedAnimeId] = useState<number | null>(null);
  const [animeSearchResults, setAnimeSearchResults] = useState<AniListResponse[]>([]);
  const [showMetadataPanel, setShowMetadataPanel] = useState(false);
  const [currentEditingFile, setCurrentEditingFile] = useState<number | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [organizeBySeasons, setOrganizeBySeasons] = useState(true);
  const [createAnimeFolders, setCreateAnimeFolders] = useState(true);
  const [manualSearchQuery, setManualSearchQuery] = useState<string>("");
  const [isSearching, setIsSearching] = useState(false);
  
  // 加载配置
  useEffect(() => {
    // 等待 Tauri 完全初始化
    const initTauri = async () => {
      // 调试信息
      console.log('检查 Tauri 环境...');
      console.log('window.__TAURI_INTERNALS__:', window.__TAURI_INTERNALS__);
      console.log('isTauriAvailable():', isTauriAvailable());
      console.log('isDialogAvailable():', isDialogAvailable());
      
      // 等待 Tauri API 可用
      let attempts = 0;
      const maxAttempts = 50;
      
      while (attempts < maxAttempts) {
        if (isTauriAvailable()) {
          console.log('Tauri API 已可用');
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      
      if (attempts >= maxAttempts) {
        console.error('Tauri API 初始化超时');
        toast.error('Tauri API 初始化失败，某些功能可能不可用');
        return;
      }
      
      loadConfig();
    };
    
    initTauri();
  }, []);
  
  const loadConfig = async () => {
    if (!isTauriAvailable()) {
      console.warn('Tauri API 不可用，使用默认配置');
      setFileNameTemplate("{title_romaji} - S{season}E{episode:02}");
      setFolderTemplate("{title_romaji} ({year})");
      setSeasonFolderTemplate("Season {season}");
      setOrganizeBySeasons(true);
      return;
    }
    
    try {
      const appConfig = await invoke<AppConfig>('load_config');
      setConfig(appConfig);
      setFileNameTemplate(appConfig.naming_template);
      setFolderTemplate(appConfig.folder_template);
      setSeasonFolderTemplate(appConfig.season_folder_template || "Season {season}");
      setOutputDir(appConfig.output_directory);
      setOrganizeBySeasons(appConfig.organize_by_season);
      setCreateAnimeFolders(appConfig.create_anime_folders !== false); // 默认为true
    } catch (error) {
      console.error("加载配置失败:", error);
      toast.error(`加载配置失败: ${error}`);
      // 使用默认配置
      setFileNameTemplate("{title_romaji} - S{season}E{episode:02}");
      setFolderTemplate("{title_romaji} ({year})");
      setSeasonFolderTemplate("Season {season}");
      setOrganizeBySeasons(true);
    }
  };

  // 处理拖拽事件 - 优化性能
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) {
      setIsDragging(true);
    }
  }, [isDragging]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 只有当鼠标真正离开拖放区域时才设置为false
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // 处理文件拖放 - 简化版本
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    try {
      // 直接处理拖拽的文件，让浏览器处理路径
      await handleFiles(files);
    } catch (error) {
      console.error("拖拽处理失败:", error);
      toast.error(`拖拽处理失败: ${error}`);
    }
  }, []);

  // 处理文件选择 - 修复版本
  const handleFileSelect = useCallback(async () => {
    if (!isDialogAvailable()) {
      toast.error('文件选择功能不可用，请检查 Tauri 环境');
      return;
    }
    
    try {
      console.log('开始选择文件...');
      
      const selected = await open({
        multiple: true,
        filters: [
          { name: '支持的文件', extensions: ['mkv', 'mp4', 'avi', 'mov', 'ass', 'srt', 'vtt', 'mka', 'flac', 'opus', 'aac'] }
        ]
      });
      console.log('文件选择结果:', selected);
      
      if (selected && Array.isArray(selected) && selected.length > 0) {
        const fileObjects: FileInfo[] = selected.map(path => {
          const name = path.split(/[/\\\\]/).pop() || '';
          const extension = name.split('.').pop()?.toLowerCase() || '';
          const is_video = ['mkv', 'mp4', 'avi', 'mov'].includes(extension);
          const is_subtitle = ['ass', 'srt', 'vtt'].includes(extension);
          const is_audio = ['mka', 'flac', 'opus', 'aac'].includes(extension);
          
          return {
            path,
            name,
            size: 0, // 文件大小将在后台获取
            file_type: extension,
            is_video,
            is_subtitle,
            is_audio
          };
        });
        
        setFiles(prev => [...prev, ...fileObjects]);
        toast.success(`已添加 ${fileObjects.length} 个文件`);
      }
    } catch (error) {
      console.error('选择文件错误:', error);
      if (error !== "User cancelled the dialog") {
        toast.error(`选择文件失败: ${error}`);
      }
    }
  }, []);


  // 处理文件 - 优化版本
  const handleFiles = useCallback((fileList: File[]) => {
    const newFiles: FileInfo[] = [];
    
    for (const file of fileList) {
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const is_video = ['mkv', 'mp4', 'avi', 'mov'].includes(extension);
      const is_subtitle = ['ass', 'srt', 'vtt'].includes(extension);
      const is_audio = ['mka', 'flac', 'opus', 'aac'].includes(extension);
      
      if (is_video || is_subtitle || is_audio) {
        // 确保获取完整路径
        const filePath = (file as any).path || '';
        if (!filePath) {
          console.warn(`文件 ${file.name} 没有完整路径信息，可能无法正确处理`);
          toast.warning(`文件 ${file.name} 缺少路径信息，请使用文件选择器选择文件`);
          continue;
        }
        
        newFiles.push({
          path: filePath,
          name: file.name,
          size: file.size,
          file_type: extension,
          is_video,
          is_subtitle,
          is_audio
        });
      }
    }
    
    if (newFiles.length > 0) {
      setFiles(prev => [...prev, ...newFiles]);
      toast.success(`已添加 ${newFiles.length} 个文件`);
    } else {
      toast.warning("没有找到支持的文件格式");
    }
  }, []);

  // 扫描目录
  const scanDirectory = async (path: string) => {
    if (!isTauriAvailable()) {
      toast.error('目录扫描功能不可用，请检查 Tauri 环境');
      return;
    }
    
    try {
      const scannedFiles = await invoke<FileInfo[]>('scan_directory', { path });
      setFiles(prev => [...prev, ...scannedFiles]);
      toast.success(`成功扫描目录: ${path}`);
    } catch (error) {
      console.error('扫描目录错误:', error);
      toast.error(`扫描目录失败: ${error}`);
    }
  };

  // 移除文件
  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  // 选择输出目录
  const selectOutputDirectory = async () => {
    if (!isDialogAvailable()) {
      toast.error('目录选择功能不可用，请检查 Tauri 环境');
      return;
    }
    
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });
      
      if (selected && !Array.isArray(selected)) {
        setOutputDir(selected);
        // 自动保存输出目录
        autoSaveConfig({ output_directory: selected });
        toast.success(`已选择输出目录: ${selected}`);
      }
    } catch (error) {
      console.error('选择目录错误:', error);
      if (error !== "User cancelled the dialog") {
        toast.error(`选择输出目录失败: ${error}`);
      }
    }
  };

  // 解析文件名
  const parseFilenames = async () => {
    if (files.length === 0) {
      toast.error("请先选择文件");
      return;
    }
    
    if (!isTauriAvailable()) {
      toast.error('文件名解析功能不可用，请检查 Tauri 环境');
      return;
    }
    
    setIsAnalyzing(true);
    
    try {
      const updatedFiles = [...files];
      let videoFiles = updatedFiles.filter(f => f.is_video);
      let parsedCount = 0;
      let firstAnimeTitle = '';
      
      // 只解析视频文件名
      for (let i = 0; i < videoFiles.length; i++) {
        try {
          const parsed = await invoke<ParsedFilename>('parse_anime_filename', {
            filename: videoFiles[i].name
          });
          
          // 更新文件信息
          const fileIndex = updatedFiles.findIndex(f => f.path === videoFiles[i].path);
          if (fileIndex !== -1) {
            updatedFiles[fileIndex].parsed = parsed;
            parsedCount++;
            
            // 记录第一个成功解析的动漫标题
            if (!firstAnimeTitle && parsed.anime_title) {
              firstAnimeTitle = parsed.anime_title;
            }
          }
        } catch (error) {
          console.error(`解析文件名失败: ${videoFiles[i].name}`, error);
        }
      }
      
      setFiles(updatedFiles);
      
      // 如果成功解析了至少一个文件，自动搜索元数据
      if (parsedCount > 0 && firstAnimeTitle) {
        console.log(`开始搜索动漫元数据: ${firstAnimeTitle}`);
        toast.success(`文件名解析完成，找到 ${parsedCount} 个文件，正在搜索动漫信息...`);
        await searchAnimeMetadata(firstAnimeTitle);
      } else {
        toast.success("文件名解析完成，但未找到可识别的动漫信息");
      }
    } catch (error) {
      console.error('解析文件名错误:', error);
      toast.error(`文件名解析失败: ${error}`);
    } finally {
      setIsAnalyzing(false);
    }
  };
  
  // 搜索动漫元数据
  const searchAnimeMetadata = async (title: string) => {
    if (!isTauriAvailable()) {
      toast.error('元数据搜索功能不可用，请检查 Tauri 环境');
      return;
    }
    
    setIsSearching(true);
    
    try {
      const results = await invoke<AniListResponse[]>('search_anilist', {
        query: title
      });
      
      setAnimeSearchResults(results);
      
      if (results.length > 0) {
        setSelectedAnimeId(results[0].id);
        await applyMetadata(results[0]);
      }
      
      setShowMetadataPanel(true);
      toast.success(`找到 ${results.length} 个搜索结果`);
    } catch (error) {
      toast.error(`搜索元数据失败: ${error}`);
    } finally {
      setIsSearching(false);
    }
  };

  // 手动搜索动漫
  const handleManualSearch = async () => {
    if (!manualSearchQuery.trim()) {
      toast.error('请输入动漫名称');
      return;
    }
    
    await searchAnimeMetadata(manualSearchQuery.trim());
  };
  
  // 提取文件名（不含扩展名）
  const getBaseName = (filename: string) => {
    const parts = filename.split('.');
    if (parts.length > 1) {
      return parts.slice(0, -1).join('.');
    }
    return filename;
  };

  // 替换Windows文件名中的非法字符为全角字符
  const sanitizeFilenameForWindows = (name: string): string => {
    return name
      .replace(/:/g, '：')
      .replace(/\?/g, '？')
      .replace(/\*/g, '＊')
      .replace(/"/g, '＂')
      .replace(/</g, '＜')
      .replace(/>/g, '＞')
      .replace(/\|/g, '｜')
      .replace(/\//g, '／')
      .replace(/\\/g, '＼');
  };

  // 提取字幕文件的语言后缀, e.g., "file.sc.ass" -> "sc"
  const extractSubtitleLanguage = (filename: string): string => {
    const parts = filename.split('.');
    if (parts.length >= 3) {
      return parts[parts.length - 2];
    }
    return '';
  };

  // 应用元数据到文件
  const applyMetadata = async (animeData: AniListResponse) => {
    if (!isTauriAvailable()) {
      toast.error('元数据应用功能不可用');
      return;
    }

    // 1. 从后端一次性获取所有详细信息，包括所有剧集标题
    const animeInfoBase = await invoke<AnimeInfo>('get_anime_details', { anilistData: animeData });
    
    const updatedFiles = [...files];
    const videoFiles = updatedFiles.filter(f => f.is_video).sort((a, b) => a.name.localeCompare(b.name));
    const sidecarFiles = updatedFiles.filter(f => f.is_subtitle || f.is_audio);

    // 2. 创建一个映射，用于根据视频文件的原始基本名称查找其新信息
    const videoFileMap = new Map<string, { info: AnimeInfo, newBaseName: string }>();

    // 3. 同步处理所有视频文件，因为数据已经获取
    for (const [index, file] of videoFiles.entries()) {
      // 优先使用 anitomy 解析出的集数和季数
      const episodeNumber = file.parsed?.episode_number ?? (index + 1);
      const seasonNumber = file.parsed?.season ?? 1;
      const groupName = file.parsed?.group;

      // 从已获取的列表中查找剧集标题
      // anilist 的 episode_titles 数组是 0-indexed
      const rawTitle = animeInfoBase.episode_titles?.[episodeNumber - 1] || '';
      // 移除 "Episode X - " 前缀
      const episodeTitle = rawTitle.replace(/^Episode\s*\d+\s*-\s*/, '');

      const animeInfo: AnimeInfo = {
        ...animeInfoBase,
        episode: episodeNumber,
        season: seasonNumber,
        episode_title: episodeTitle,
      };

      // 生成新文件名
      let newFullName = fileNameTemplate
        .replace(/{title}/g, animeInfo.title)
        .replace(/{title_romaji}/g, animeInfo.title_romaji || animeInfo.title)
        .replace(/{title_english}/g, animeInfo.title_english || animeInfo.title)
        .replace(/{episode}/g, episodeNumber.toString())
        .replace(/{episode:02}/g, episodeNumber.toString().padStart(2, '0'))
        .replace(/{episode:03}/g, episodeNumber.toString().padStart(3, '0'))
        .replace(/{season}/g, seasonNumber.toString())
        .replace(/{year}/g, animeInfo.year?.toString() || "")
        .replace(/{quarter}/g, animeInfo.quarter || "")
        .replace(/{group}/g, groupName || "")
        .replace(/{episode_title}/g, animeInfo.episode_title || "")
        .replace(/{ext}/g, file.file_type)
        .replace(/\s+/g, ' ').trim();
      
      // 移除未使用的占位符并清理空白
      newFullName = newFullName.replace(/{[^}]+}/g, "").replace(/--/g, '-').replace(/  +/g, ' ').trim();

      // 如果用户模板不包含 {ext}，则在末尾添加
      if (!fileNameTemplate.includes('{ext}')) {
        newFullName = `${newFullName}.${file.file_type}`;
      }

      // 为Windows清理文件名
      newFullName = sanitizeFilenameForWindows(newFullName);

      const newBaseName = newFullName.substring(0, newFullName.lastIndexOf('.'));
      
      const originalIndex = updatedFiles.findIndex(f => f.path === file.path);
      if (originalIndex !== -1) {
        updatedFiles[originalIndex].metadata = animeInfo;
        updatedFiles[originalIndex].new_name = newFullName;
      }
      
      // 存储视频信息以供字幕匹配
      const originalBaseName = getBaseName(file.name);
      videoFileMap.set(originalBaseName, { info: animeInfo, newBaseName });
    }

    // 4. 处理所有附加文件 (字幕和音频)
    sidecarFiles.forEach(file => {
      const language = extractSubtitleLanguage(file.name);
      const originalBaseName = getBaseName(file.name);

      let videoBaseNameToMatch: string;
      if (language) {
        const suffixToRemove = `.${language}`;
        if (originalBaseName.endsWith(suffixToRemove)) {
          videoBaseNameToMatch = originalBaseName.slice(0, -suffixToRemove.length);
        } else {
          videoBaseNameToMatch = originalBaseName;
        }
      } else {
        videoBaseNameToMatch = originalBaseName;
      }
      
      const videoMatch = videoFileMap.get(videoBaseNameToMatch);

      if (videoMatch) {
        const { info, newBaseName } = videoMatch;
        
        // 使用自动检测的后缀
        const suffix = language ? `.${language}` : '';

        const newFullName = `${newBaseName}${suffix}.${file.file_type}`;
        
        const originalIndex = updatedFiles.findIndex(f => f.path === file.path);
        if (originalIndex !== -1) {
          updatedFiles[originalIndex].metadata = info; // 继承视频的元数据
          updatedFiles[originalIndex].new_name = newFullName;
        }
      } else {
        // 未找到匹配的视频文件，不进行重命名
        const originalIndex = updatedFiles.findIndex(f => f.path === file.path);
        if (originalIndex !== -1) {
          // 将 new_name 设为 undefined，这样它就不会被处理
          updatedFiles[originalIndex].new_name = undefined;
        }
        console.warn(`无法为字幕文件找到匹配的视频，将不进行重命名: ${file.name}`);
      }
    });

    setFiles(updatedFiles);

    // 5. 提供反馈
    const videoCount = videoFiles.length;
    const processedSidecarCount = sidecarFiles.filter(sf => {
      const updatedFile = updatedFiles.find(uf => uf.path === sf.path);
      return updatedFile && updatedFile.new_name;
    }).length;
    const orphanCount = sidecarFiles.length - processedSidecarCount;
    
    let message = `已为 ${videoCount} 个视频文件和 ${processedSidecarCount} 个附加文件 (字幕/音频) 生成新名称。`;
    if (orphanCount > 0) {
      message += ` 有 ${orphanCount} 个附加文件因未找到匹配视频而未处理。`;
      toast.warning(message);
    } else {
      toast.success(message);
    }
    
    if (animeData.episodes && videoCount !== animeData.episodes) {
      toast.warning(`注意：检测到 ${videoCount} 个视频文件，但该动漫共有 ${animeData.episodes} 集`);
    }
  };
  
  // 选择不同的元数据结果
  const selectAnimeMetadata = async (animeId: number) => {
    const selected = animeSearchResults.find(anime => anime.id === animeId);
    if (selected) {
      setSelectedAnimeId(animeId);
      await applyMetadata(selected);
    }
  };
  
  // 处理文件
  const processFiles = async () => {
    if (files.length === 0) {
      toast.error("请先选择文件");
      return;
    }
    
    if (!outputDir) {
      toast.error("请选择输出目录");
      return;
    }
    
    if (!isTauriAvailable()) {
      toast.error('文件处理功能不可用，请检查 Tauri 环境');
      return;
    }
    
    try {
      // 检查硬链接能力
      const canHardlink = await invoke<boolean>('check_hardlink_capability', {
        sourceDir: files[0].path.split(/[/\\\\]/).slice(0, -1).join('/'),
        targetDir: outputDir
      });
      
      if (!canHardlink) {
        toast.error("源目录和目标目录不支持硬链接，请选择同一文件系统上的目录");
        return;
      }
      
      setIsProcessing(true);
      setProcessingProgress(0);
      
      // 模拟进度
      const progressInterval = setInterval(() => {
        setProcessingProgress(prev => {
          const newProgress = prev + (100 - prev) * 0.1;
          return newProgress > 95 ? 95 : newProgress;
        });
      }, 300);
      
      // 准备重命名映射
      const renameMap: Record<string, string> = {};
      
      // 如果有元数据，创建基于动漫的文件夹结构
      if (files.some(f => f.metadata)) {
        // 获取第一个有元数据的文件
        const fileWithMetadata = files.find(f => f.metadata);
        if (fileWithMetadata && fileWithMetadata.metadata) {
          // 处理每个文件
          files.forEach(file => {
            if (file.new_name && file.metadata) { // 确保文件有新名称和元数据
              let targetPath = "";
              const currentAnimeInfo = file.metadata; // 使用文件自身的元数据

              // 如果启用创建动漫文件夹
              if (createAnimeFolders) {
                let animeFolder = folderTemplate;
                animeFolder = animeFolder.replace(/{title}/g, currentAnimeInfo.title);
                animeFolder = animeFolder.replace(/{title_romaji}/g, currentAnimeInfo.title_romaji || currentAnimeInfo.title);
                animeFolder = animeFolder.replace(/{title_english}/g, currentAnimeInfo.title_english || currentAnimeInfo.title);
                
                if (currentAnimeInfo.year) {
                  animeFolder = animeFolder.replace(/{year}/g, currentAnimeInfo.year.toString());
                } else {
                  animeFolder = animeFolder.replace(/ \({year}\)/g, "").replace(/\({year}\)/g, "");
                }

                if (currentAnimeInfo.quarter) {
                  animeFolder = animeFolder.replace(/{quarter}/g, currentAnimeInfo.quarter);
                } else {
                  animeFolder = animeFolder.replace(/ {quarter}/g, "").replace(/{quarter}/g, "");
                }
                
                targetPath = animeFolder;
                
                // 如果按季度组织且有季度信息
                if (organizeBySeasons && currentAnimeInfo.season) {
                  let seasonFolder = seasonFolderTemplate;
                  seasonFolder = seasonFolder
                    .replace(/{season}/g, String(currentAnimeInfo.season ?? ''))
                    .replace(/{season:02}/g, String(currentAnimeInfo.season ?? '').padStart(2, '0'))
                    .replace(/{season:03}/g, String(currentAnimeInfo.season ?? '').padStart(3, '0'))
                    .replace(/{year}/g, currentAnimeInfo.year?.toString() || "")
                    .replace(/{quarter}/g, currentAnimeInfo.quarter || "");
                  targetPath += `/${seasonFolder}`;
                }
                
                // 完整路径
                targetPath += `/${file.new_name}`;
              } else {
                // 不创建动漫文件夹，但可能创建季度文件夹
                if (organizeBySeasons && file.metadata?.season) {
                  const currentAnimeInfo = file.metadata;
                  let seasonFolder = seasonFolderTemplate;
                  seasonFolder = seasonFolder
                    .replace(/{season}/g, String(currentAnimeInfo.season ?? ''))
                    .replace(/{season:02}/g, String(currentAnimeInfo.season ?? '').padStart(2, '0'))
                    .replace(/{season:03}/g, String(currentAnimeInfo.season ?? '').padStart(3, '0'))
                    .replace(/{year}/g, currentAnimeInfo.year?.toString() || "")
                    .replace(/{quarter}/g, currentAnimeInfo.quarter || "");
                  targetPath = `${seasonFolder}/${file.new_name}`;
                } else {
                  // 直接使用新文件名
                  targetPath = file.new_name;
                }
              }
              
              renameMap[file.path] = targetPath;
            }
          });
        }
      } else {
        // 简单模式，直接使用新文件名
        files.forEach(file => {
          if (file.new_name) {
            renameMap[file.path] = file.new_name;
          }
        });
      }
      
      // 批量处理文件 - 使用新的季度文件夹处理函数
      const result = await invoke<ProcessResult>('batch_process_with_season_folders', {
        files: files.map(f => f.path),
        outputDir,
        renameMap,
        createSeasonFolders: organizeBySeasons,
        seasonFolderTemplate: seasonFolderTemplate
      });
      
      clearInterval(progressInterval);
      setProcessingProgress(100);
      
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.warning(result.message);
        if (result.failed_files.length > 0) {
          console.error("处理失败的文件:", result.failed_files);
        }
      }
    } catch (error) {
      toast.error(`处理文件失败: ${error}`);
    } finally {
      setIsProcessing(false);
      // 延迟重置进度条，以便用户看到完成状态
      setTimeout(() => setProcessingProgress(0), 2000);
    }
  };
  
  // 保存当前设置到配置
  const saveCurrentSettings = async () => {
    if (!config || !isTauriAvailable()) {
      toast.error('配置保存功能不可用，请检查 Tauri 环境');
      return;
    }
    
    try {
      const updatedConfig = {
        ...config,
        output_directory: outputDir || config.output_directory,
        naming_template: fileNameTemplate,
        folder_template: folderTemplate,
        season_folder_template: seasonFolderTemplate,
        organize_by_season: organizeBySeasons
      };
      
      const saved = await invoke<boolean>('save_config', { config: updatedConfig });
      if (saved) {
        toast.success("设置已保存");
        setConfig(updatedConfig);
      }
    } catch (error) {
      toast.error(`保存设置失败: ${error}`);
    }
  };
  
  // 编辑单个文件的新名称
  const editFileName = (index: number, newName: string) => {
    const updatedFiles = [...files];
    updatedFiles[index].new_name = newName;
    setFiles(updatedFiles);
  };
  
  // 更新文件名模板并应用到所有文件
  const updateFileNameTemplate = async (template: string) => {
    setFileNameTemplate(template);
    
    // 自动保存配置
    autoSaveConfig({ naming_template: template });
    
    // 如果有选中的动漫元数据，重新应用
    if (selectedAnimeId !== null) {
      const selected = animeSearchResults.find(anime => anime.id === selectedAnimeId);
      if (selected) {
        await applyMetadata(selected);
      }
    }
  };

  // 更新文件夹模板并自动保存
  const updateFolderTemplate = (template: string) => {
    setFolderTemplate(template);
    autoSaveConfig({ folder_template: template });
  };

  // 更新季度文件夹模板并自动保存
  const updateSeasonFolderTemplate = (template: string) => {
    setSeasonFolderTemplate(template);
    autoSaveConfig({ season_folder_template: template });
  };

  // 更新按季度组织设置并自动保存
  const updateOrganizeBySeasons = (organize: boolean) => {
    setOrganizeBySeasons(organize);
    autoSaveConfig({ organize_by_season: organize });
  };

  // 更新创建动漫文件夹设置并自动保存
  const updateCreateAnimeFolders = (create: boolean) => {
    setCreateAnimeFolders(create);
    autoSaveConfig({ create_anime_folders: create });
  };

  // 自动保存配置的辅助函数
  const autoSaveConfig = async (updates: Partial<AppConfig>) => {
    if (!config || !isTauriAvailable()) return;
    
    try {
      const updatedConfig = {
        ...config,
        output_directory: outputDir || config.output_directory,
        naming_template: fileNameTemplate,
        folder_template: folderTemplate,
        season_folder_template: seasonFolderTemplate,
        organize_by_season: organizeBySeasons,
        ...updates
      };
      
      await invoke<boolean>('save_config', { config: updatedConfig });
      setConfig(updatedConfig);
      console.log('配置已自动保存:', updates);
    } catch (error) {
      console.error('自动保存配置失败:', error);
    }
  };


  // 清空文件列表
  const clearFiles = () => {
    setFiles([]);
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">文件导入</h1>
      <p className="text-muted-foreground mb-6">
        导入视频文件（MKV/MP4）和字幕文件（ASS/SRT）进行处理
      </p>
      
      {/* Tauri 状态提示 */}
      {!isTauriAvailable() && (
        <div className="mb-4 p-3 bg-yellow-100 border border-yellow-400 text-yellow-700 rounded-md">
          ⚠️ Tauri API 不可用，某些功能可能无法正常工作。请确保应用在 Tauri 环境中运行。
        </div>
      )}
      
      {/* 拖放区域 */}
      <div 
        className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors
          ${isDragging ? 'border-primary bg-primary/5' : 'border-primary/20 hover:border-primary/50'}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div className="flex flex-col items-center justify-center gap-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`${isDragging ? 'text-primary' : 'text-primary/60'}`}
          >
            <path d="M4 22h16a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v4" />
            <polyline points="14 2 14 8 20 8" />
            <path d="M2 15h10v5h-8a2 2 0 0 1-2-2z" />
            <path d="m9 15-2-2-2 2" />
          </svg>
          <p className="text-lg font-medium">拖放文件到此处或点击选择文件</p>
          <p className="text-sm text-muted-foreground">
            支持 MKV、MP4、ASS、SRT 格式文件
          </p>
          <div className="flex gap-2 mt-4">
            <Button onClick={handleFileSelect}>
              选择文件
            </Button>
            <Button variant="outline" onClick={() => {
              const path = prompt("请输入目录路径");
              if (path) scanDirectory(path);
            }}>
              <FolderOpen className="mr-2 h-4 w-4" />
              扫描目录
            </Button>
          </div>
        </div>
      </div>
      
      {/* 处理控制区 */}
      {files.length > 0 && (
        <div className="mt-6 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={selectOutputDirectory}>
                <FolderOpen className="mr-2 h-4 w-4" />
                选择输出目录
              </Button>
              {outputDir && (
                <span className="text-sm text-muted-foreground">
                  输出到: {outputDir}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={parseFilenames} disabled={isAnalyzing || isProcessing || !isTauriAvailable()}>
                {isAnalyzing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    解析中...
                  </>
                ) : (
                  <>
                    <Search className="mr-2 h-4 w-4" />
                    解析文件名
                  </>
                )}
              </Button>
              <Button variant="destructive" onClick={clearFiles} disabled={isProcessing || isAnalyzing}>
                清空列表
              </Button>
              <Button onClick={processFiles} disabled={isProcessing || !outputDir || !isTauriAvailable()}>
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    处理中...
                  </>
                ) : (
                  <>
                    <Upload className="mr-2 h-4 w-4" />
                    开始处理
                  </>
                )}
              </Button>
            </div>
          </div>
          
          {/* 进度条 */}
          {isProcessing && processingProgress > 0 && (
            <div className="w-full">
              <Progress value={processingProgress} className="w-full" />
              <p className="text-sm text-muted-foreground mt-1">
                处理进度: {Math.round(processingProgress)}%
              </p>
            </div>
          )}

          {/* 手动搜索动漫 */}
          <div className="flex items-center gap-2 p-4 bg-gray-50 rounded-lg">
            <Search className="h-4 w-4 text-gray-500" />
            <input
              type="text"
              value={manualSearchQuery}
              onChange={(e) => setManualSearchQuery(e.target.value)}
              placeholder="输入动漫名称进行搜索..."
              className="flex-1 px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleManualSearch();
                }
              }}
              disabled={isSearching || !isTauriAvailable()}
            />
            <Button 
              onClick={handleManualSearch} 
              disabled={isSearching || !manualSearchQuery.trim() || !isTauriAvailable()}
              size="sm"
            >
              {isSearching ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  搜索中...
                </>
              ) : (
                '搜索动漫'
              )}
            </Button>
          </div>
        </div>
      )}
      
      {/* 设置面板 */}
      {files.length > 0 && (
        <div className="mt-6 p-4 border rounded-lg">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">文件命名设置</h3>
            <Button variant="outline" size="sm" onClick={saveCurrentSettings} disabled={!isTauriAvailable()}>
              <Settings className="mr-2 h-4 w-4" />
              保存设置
            </Button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">视频文件名模板</label>
              <input
                type="text"
                value={fileNameTemplate}
                onChange={(e) => updateFileNameTemplate(e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
                placeholder="{title_romaji} - {episode:02}"
              />
              <p className="text-xs text-muted-foreground mt-1">
                视频文件命名模板
              </p>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">动漫文件夹模板</label>
              <input
                type="text"
                value={folderTemplate}
                onChange={(e) => updateFolderTemplate(e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
                placeholder="{title_romaji} ({year})"
              />
              <p className="text-xs text-muted-foreground mt-1">
                动漫主文件夹命名模板
              </p>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">季度文件夹模板</label>
              <input
                type="text"
                value={seasonFolderTemplate}
                onChange={(e) => updateSeasonFolderTemplate(e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 text-white border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400"
                placeholder="Season {season}"
              />
              <p className="text-xs text-muted-foreground mt-1">
                季度子文件夹命名模板
              </p>
            </div>
          </div>
          
          <div className="mt-2">
            <p className="text-xs text-muted-foreground">
              文件名变量: {"{title}, {title_romaji}, {title_english}, {episode}, {episode:02}, {episode:03}, {season}, {year}, {quarter}, {group}, {ext}, {episode_title}"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              文件夹变量: {"{title}, {title_romaji}, {title_english}, {year}, {quarter}"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              季度文件夹变量: {"{season}, {season:02}, {season:03}, {year}, {quarter}"}
            </p>
          </div>
          
          <div className="mt-4 space-y-2">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={createAnimeFolders}
                onChange={(e) => updateCreateAnimeFolders(e.target.checked)}
                className="mr-2"
              />
              创建动漫文件夹
            </label>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={organizeBySeasons}
                onChange={(e) => updateOrganizeBySeasons(e.target.checked)}
                className="mr-2"
              />
              按季度组织文件夹
            </label>
          </div>
        </div>
      )}
      
      {/* 元数据面板 */}
      {showMetadataPanel && animeSearchResults.length > 0 && (
        <div className="mt-6 p-4 border rounded-lg">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">选择动漫信息</h3>
            <Button variant="ghost" size="sm" onClick={() => setShowMetadataPanel(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {animeSearchResults.map((anime) => (
              <div
                key={anime.id}
                className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                  selectedAnimeId === anime.id ? 'border-primary bg-primary/5' : 'hover:border-primary/50'
                }`}
                onClick={() => selectAnimeMetadata(anime.id)}
              >
                <div className="flex items-start gap-3">
                  {anime.cover_image?.medium && (
                    <img
                      src={anime.cover_image.medium}
                      alt={anime.title.romaji || anime.title.english || ''}
                      className="w-16 h-20 object-cover rounded"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium text-sm line-clamp-2">
                      {anime.title.romaji || anime.title.english}
                    </h4>
                    {anime.title.english && anime.title.romaji !== anime.title.english && (
                      <p className="text-xs text-muted-foreground line-clamp-1">
                        {anime.title.english}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      {anime.season_year && <span>{anime.season_year}</span>}
                      {anime.format && <span>{anime.format}</span>}
                      {anime.episodes && <span>{anime.episodes}话</span>}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* 文件列表 */}
      {files.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">文件列表 ({files.length})</h3>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Info className="h-4 w-4" />
              <span>视频: {files.filter(f => f.is_video).length}</span>
              <span>字幕: {files.filter(f => f.is_subtitle).length}</span>
              <span>音频: {files.filter(f => f.is_audio).length}</span>
            </div>
          </div>
          
          <div className="space-y-2">
            {files.map((file, index) => (
              <div key={index} className="flex items-center gap-3 p-3 border rounded-lg">
                <div className="flex-shrink-0">
                  {file.is_video ? (
                    <FileVideo className="h-5 w-5 text-blue-500" />
                  ) : file.is_subtitle ? (
                    <FileText className="h-5 w-5 text-green-500" />
                  ) : file.is_audio ? (
                    <FileMusic className="h-5 w-5 text-purple-500" />
                  ) : (
                    <File className="h-5 w-5 text-gray-500" />
                  )}
                </div>
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-sm truncate">{file.name}</p>
                    {file.size > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {bytesToSize(file.size)}
                      </span>
                    )}
                  </div>
                  
                  {file.parsed && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      <span>解析结果: {file.parsed.anime_title}</span>
                      {file.parsed.episode_number && (
                        <span> - 第{file.parsed.episode_number}话</span>
                      )}
                      {file.parsed.season && (
                        <span> (第{file.parsed.season}季)</span>
                      )}
                      {file.parsed.group && (
                        <span> [{file.parsed.group}]</span>
                      )}
                    </div>
                  )}
                  
                  {file.new_name && (
                    <div className="mt-1 flex items-center gap-2">
                      {currentEditingFile === index ? (
                        <input
                          type="text"
                          value={file.new_name}
                          onChange={(e) => editFileName(index, e.target.value)}
                          onBlur={() => setCurrentEditingFile(null)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              setCurrentEditingFile(null);
                            }
                          }}
                          className="flex-1 px-2 py-1 text-xs bg-gray-700 text-white border border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                          autoFocus
                        />
                      ) : (
                        <>
                          <span className="text-xs text-green-600 flex-1 truncate">
                            新名称: {file.new_name}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCurrentEditingFile(index)}
                            className="h-6 w-6 p-0"
                          >
                            <Edit className="h-3 w-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeFile(index)}
                  className="flex-shrink-0 h-8 w-8 p-0 text-red-500 hover:text-red-700"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ImportPage;