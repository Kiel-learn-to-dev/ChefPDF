/**
 * Param types of the v0.1 operations, following docs/CONTRACTS.md §6 exactly.
 * TODO(integration): switch to `@chef/contracts` generated types
 * (packages/contracts/src/generated/ops.ts) once the core codegen produces them.
 * Page indices are 0-based.
 */

import type {
  ImageCleanupParams,
  ImageFromStrokesParams,
  ImageRemoveBackgroundParams,
  ImageTextSignatureParams,
  ScanFitSizeParams,
  ScanPreviewParams,
  ScanRasterizeParams,
  SignAddFieldParams,
  SignBatchParams,
  SignCertInfoParams,
  SignDiagnoseTokenParams,
  SignFindAnchorsParams,
  SignListFieldsParams,
  SignPadesParams,
  SignPadesTokenParams,
  SignPlaceFromAnchorParams,
  SignDriverScanParams,
  SignExtractRevisionParams,
  SignListTokensParams,
  SignTrustAddParams,
  SignTrustListParams,
  SignTrustRemoveParams,
  SignVerifyParams,
  OverlayAddImageParams,
  OverlayAddTextParams,
  OverlayBarcodeParams,
  OverlayBatesParams,
  OverlayHeaderFooterParams,
  OverlayLetterheadParams,
  OverlayListOverlaysParams,
  OverlayPageNumbersParams,
  OverlayQrCodeParams,
  OverlayRemoveParams,
  OverlayWatermarkParams,
  StampImageParams,
  StampPresetsParams,
  StampTextParams,
  SecurityDecryptParams,
  SecurityEncryptParams,
  InspectHiddenDataParams,
  InspectRemoveHiddenParams,
  PreflightCheckParams,
  CompressPdfParams,
  CompressEstimateParams,
  CompressFitSizeParams,
  ConvertPdfToImagesParams,
  ConvertImagesToPdfParams,
  StampSeamParams,
  StampInitialsParams,
  SignStampAndSignParams,
  SignStampAndSignTokenParams,
  SignVerifyBatchParams,
  BookmarksGetParams,
  BookmarksSetParams,
  BookmarksFromPagesParams,
  BookmarksClearParams,
  ImageSeparateColorsParams,
  ColorConvertParams,
  FileSplitSmartParams,
  PageCropParams,
  PageFindBlankParams,
  PageRemoveBlankParams,
  PageReplaceParams,
  PageResizeParams,
  PageSplitParams,
  DocAttachmentsAddParams,
  DocAttachmentsExtractParams,
  DocAttachmentsListParams,
  DocAttachmentsRemoveParams,
  DocExtractImagesParams,
  DocExtractTextParams,
  DocOptimizeWebParams,
  DocRepairParams,
  DocSetMetadataParams,
  ContentAdjustImageParams,
  ContentDeleteParams,
  ContentDuplicateParams,
  ContentEraseRegionParams,
  ContentExtractImageParams,
  ContentListObjectsParams,
  ContentMoveParams,
  ContentReorderParams,
  ContentReplaceImageParams,
  ContentSetColorParams,
  ContentSetOpacityParams,
  ContentViewByTypeParams,
  LayersFlattenParams,
  LayersListParams,
  LayersRemoveParams,
  LayersSetVisibilityParams,
  BackgroundDetectParams,
  BackgroundRemoveParams,
  ContentHitTestParams,
  ContentRemoveSimilarParams,
  RedactApplyParams,
  RedactFindParams,
  WatermarkDetectParams,
  WatermarkRemoveParams,
} from '@chef/contracts';

export type RotateAngle = 90 | 180 | 270;
export type SplitMode = 'ranges' | 'everyN' | 'bookmarks' | 'maxSize' | 'oddEven';
export type ImageSource = { path: string } | { dataUrl: string };

export interface OpParams {
  'page.rotate': { pages: number[]; angle: RotateAngle };
  'page.delete': { pages: number[] };
  'page.duplicate': { pages: number[] };
  'page.reorder': { order: number[] };
  'page.extract': { pages: number[]; outputPath: string };
  'page.insertBlank': { at: number; count: number; width?: number; height?: number };
  'page.insertFromFile': { at: number; path: string; password?: string; pages?: number[] };
  'page.insertImages': {
    at: number;
    images: ImageSource[];
    pageSize: 'image' | 'a4' | 'letter';
    margin: number;
  };
  'file.merge': {
    inputs: { path: string; password?: string; pages?: number[] }[];
    outputPath: string;
    bookmarksFromFilenames: boolean;
  };
  'file.split': {
    mode: SplitMode;
    ranges?: string;
    n?: number;
    maxBytes?: number;
    outputDir: string;
    nameTemplate: string;
  };
  'scan.rasterize': ScanRasterizeParams;
  'scan.preview': ScanPreviewParams;
  'scan.fitSize': ScanFitSizeParams;
  'sign.certInfo': SignCertInfoParams;
  'sign.driverScan': SignDriverScanParams;
  'sign.listTokens': SignListTokensParams;
  'sign.diagnoseToken': SignDiagnoseTokenParams;
  'sign.verify': SignVerifyParams;
  'sign.pades': SignPadesParams;
  'sign.padesToken': SignPadesTokenParams;
  'sign.addField': SignAddFieldParams;
  'sign.listFields': SignListFieldsParams;
  'sign.findAnchors': SignFindAnchorsParams;
  'sign.placeFromAnchor': SignPlaceFromAnchorParams;
  'sign.batch': SignBatchParams;
  'sign.extractRevision': SignExtractRevisionParams;
  'sign.trustList': SignTrustListParams;
  'sign.trustAdd': SignTrustAddParams;
  'sign.trustRemove': SignTrustRemoveParams;
  'image.removeBackground': ImageRemoveBackgroundParams;
  'image.cleanup': ImageCleanupParams;
  'image.fromStrokes': ImageFromStrokesParams;
  'image.textSignature': ImageTextSignatureParams;
  'overlay.addText': OverlayAddTextParams;
  'overlay.addImage': OverlayAddImageParams;
  'overlay.watermark': OverlayWatermarkParams;
  'overlay.headerFooter': OverlayHeaderFooterParams;
  'overlay.pageNumbers': OverlayPageNumbersParams;
  'overlay.bates': OverlayBatesParams;
  'overlay.qrCode': OverlayQrCodeParams;
  'overlay.barcode': OverlayBarcodeParams;
  'overlay.letterhead': OverlayLetterheadParams;
  'overlay.listOverlays': OverlayListOverlaysParams;
  'overlay.remove': OverlayRemoveParams;
  'stamp.text': StampTextParams;
  'stamp.image': StampImageParams;
  'stamp.presets': StampPresetsParams;
  'security.encrypt': SecurityEncryptParams;
  'security.decrypt': SecurityDecryptParams;
  'inspect.hiddenData': InspectHiddenDataParams;
  'inspect.removeHidden': InspectRemoveHiddenParams;
  'preflight.check': PreflightCheckParams;
  'compress.pdf': CompressPdfParams;
  'compress.estimate': CompressEstimateParams;
  'compress.fitSize': CompressFitSizeParams;
  'convert.pdfToImages': ConvertPdfToImagesParams;
  'convert.imagesToPdf': ConvertImagesToPdfParams;
  'stamp.seam': StampSeamParams;
  'stamp.initials': StampInitialsParams;
  'sign.stampAndSign': SignStampAndSignParams;
  'sign.stampAndSignToken': SignStampAndSignTokenParams;
  'sign.verifyBatch': SignVerifyBatchParams;
  'bookmarks.get': BookmarksGetParams;
  'bookmarks.set': BookmarksSetParams;
  'bookmarks.fromPages': BookmarksFromPagesParams;
  'bookmarks.clear': BookmarksClearParams;
  'image.separateColors': ImageSeparateColorsParams;
  'doc.setMetadata': DocSetMetadataParams;
  'doc.attachments.list': DocAttachmentsListParams;
  'doc.attachments.add': DocAttachmentsAddParams;
  'doc.attachments.extract': DocAttachmentsExtractParams;
  'doc.attachments.remove': DocAttachmentsRemoveParams;
  'doc.extractImages': DocExtractImagesParams;
  'doc.extractText': DocExtractTextParams;
  'doc.optimizeWeb': DocOptimizeWebParams;
  'doc.repair': DocRepairParams;
  'color.convert': ColorConvertParams;
  'page.replace': PageReplaceParams;
  'page.crop': PageCropParams;
  'page.resize': PageResizeParams;
  'page.findBlank': PageFindBlankParams;
  'page.removeBlank': PageRemoveBlankParams;
  'page.split': PageSplitParams;
  'file.splitSmart': FileSplitSmartParams;
  'content.listObjects': ContentListObjectsParams;
  'content.viewByType': ContentViewByTypeParams;
  'content.move': ContentMoveParams;
  'content.delete': ContentDeleteParams;
  'content.duplicate': ContentDuplicateParams;
  'content.reorder': ContentReorderParams;
  'content.setColor': ContentSetColorParams;
  'content.setOpacity': ContentSetOpacityParams;
  'content.replaceImage': ContentReplaceImageParams;
  'content.adjustImage': ContentAdjustImageParams;
  'content.extractImage': ContentExtractImageParams;
  'content.eraseRegion': ContentEraseRegionParams;
  'layers.list': LayersListParams;
  'layers.setVisibility': LayersSetVisibilityParams;
  'layers.remove': LayersRemoveParams;
  'layers.flatten': LayersFlattenParams;
  'watermark.detect': WatermarkDetectParams;
  'watermark.remove': WatermarkRemoveParams;
  'content.hitTest': ContentHitTestParams;
  'content.removeSimilar': ContentRemoveSimilarParams;
  'background.detect': BackgroundDetectParams;
  'background.remove': BackgroundRemoveParams;
  'redact.find': RedactFindParams;
  'redact.apply': RedactApplyParams;
}

export type OpId = keyof OpParams;

export const STANDALONE_OPS: ReadonlySet<OpId> = new Set<OpId>([
  'file.merge',
  'convert.pdfToImages',
  'convert.imagesToPdf',
  'sign.certInfo',
  'sign.driverScan',
  'sign.listTokens',
  'sign.diagnoseToken',
  'sign.extractRevision',
  'sign.trustList',
  'sign.trustAdd',
  'sign.trustRemove',
  'sign.batch',
  'image.removeBackground',
  'image.cleanup',
  'image.fromStrokes',
  'image.textSignature',
  'overlay.bates',
  'stamp.presets',
  'sign.verifyBatch',
  'image.separateColors',
  'doc.optimizeWeb',
  'doc.repair',
]);
