/**
 * Strings shown by the main process (native menu, dialogs). Vietnamese is the default,
 * English follows `settings.language`. The renderer has its own i18next catalogs.
 */
import type { LanguageSetting } from '@chef/contracts';

const vi = {
  appName: 'Chef PDF',
  file: 'Tệp',
  open: 'Mở…',
  closeWindow: 'Đóng cửa sổ',
  quit: 'Thoát',
  edit: 'Sửa',
  undo: 'Hoàn tác',
  redo: 'Làm lại',
  cut: 'Cắt',
  copy: 'Sao chép',
  paste: 'Dán',
  selectAll: 'Chọn tất cả',
  view: 'Xem',
  reload: 'Tải lại',
  devTools: 'Công cụ nhà phát triển',
  resetZoom: 'Cỡ thật',
  zoomIn: 'Phóng to',
  zoomOut: 'Thu nhỏ',
  fullscreen: 'Toàn màn hình',
  window: 'Cửa sổ',
  minimize: 'Thu nhỏ cửa sổ',
  zoom: 'Phóng to cửa sổ',
  front: 'Đưa tất cả ra trước',
  help: 'Trợ giúp',
  about: 'Giới thiệu Chef PDF',
  openLogs: 'Mở thư mục nhật ký',
  openData: 'Mở thư mục dữ liệu',
  hide: 'Ẩn Chef PDF',
  hideOthers: 'Ẩn các ứng dụng khác',
  unhide: 'Hiện tất cả',
  services: 'Dịch vụ',
  pdfFiles: 'Tệp PDF',
  allFiles: 'Tất cả tệp',
  aboutDetail: (version: string, electron: string, chrome: string, node: string) =>
    `Phiên bản ${version}\nElectron ${electron} · Chromium ${chrome} · Node ${node}`,
};

export type Labels = typeof vi;

const en: Labels = {
  appName: 'Chef PDF',
  file: 'File',
  open: 'Open…',
  closeWindow: 'Close Window',
  quit: 'Quit',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  view: 'View',
  reload: 'Reload',
  devTools: 'Developer Tools',
  resetZoom: 'Actual Size',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  fullscreen: 'Full Screen',
  window: 'Window',
  minimize: 'Minimize',
  zoom: 'Zoom',
  front: 'Bring All to Front',
  help: 'Help',
  about: 'About Chef PDF',
  openLogs: 'Open Logs Folder',
  openData: 'Open Data Folder',
  hide: 'Hide Chef PDF',
  hideOthers: 'Hide Others',
  unhide: 'Show All',
  services: 'Services',
  pdfFiles: 'PDF files',
  allFiles: 'All files',
  aboutDetail: (version, electron, chrome, node) =>
    `Version ${version}\nElectron ${electron} · Chromium ${chrome} · Node ${node}`,
};

export function labelsFor(language: LanguageSetting): Labels {
  return language === 'en' ? en : vi;
}
