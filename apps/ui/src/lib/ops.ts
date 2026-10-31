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
}

export type OpId = keyof OpParams;

export const STANDALONE_OPS: ReadonlySet<OpId> = new Set<OpId>([
  'file.merge',
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
]);
