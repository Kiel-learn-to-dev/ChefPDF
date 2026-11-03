import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Crop, Info, RotateCw, ScanText } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocTab } from '../../app/state/documents';
import {
  defaultView,
  nextZoom,
  useViewStore,
  type ViewMode,
  type ViewState,
} from '../../app/state/viewer';
import { useUi } from '../../app/state/ui';
import { ContextMenu } from '../../components/Menu';
import { EmptyState, ProgressBar, Spinner } from '../../components/Misc';
import { chef } from '../../lib/bridge';
import { usePdfDocument } from './pdfCache';
import { getViewer, registerViewer, type FindRequest } from './controllers';
import { useFind, statusFromPdfjs } from './findStore';
import {
  AnnotationMode,
  ChefFindController,
  EventBus,
  PDFLinkService,
  PDFViewer,
  ScrollMode,
  SpreadMode,
} from './viewerLib';
import { SnapshotLayer } from './SnapshotLayer';
import { PlacementOverlay } from '../sign/PlacementOverlay';
import { OverlayPlacementLayer } from '../overlay/OverlayPlacementLayer';
import { HighlightLayer } from '../redact/HighlightLayer';
import { ObjectLayer } from '../objects/ObjectLayer';
import { EraseLayer } from '../erase/EraseLayer';
import { TextEditLayer } from '../textedit/TextEditLayer';
import { LinkDrawLayer } from '../links/LinkDrawLayer';
import { FormDrawLayer } from '../forms/FormDrawLayer';
import { AnnotLayer } from '../annots/AnnotLayer';
import { FindBar } from './FindBar';
import './Viewer.css';

const MODE_TO_PDFJS: Record<ViewMode, { scroll: number; spread: number }> = {
  single: { scroll: ScrollMode.PAGE, spread: SpreadMode.NONE },
  continuous: { scroll: ScrollMode.VERTICAL, spread: SpreadMode.NONE },
  twoPage: { scroll: ScrollMode.VERTICAL, spread: SpreadMode.ODD },
  book: { scroll: ScrollMode.VERTICAL, spread: SpreadMode.EVEN },
};

interface Parts {
  viewer: PDFViewer;
  linkService: PDFLinkService;
  eventBus: EventBus;
  findController: ChefFindController;
}

function currentView(docId: string): ViewState {
  return useViewStore.getState().views[docId] ?? defaultView;
}

function lastFindRequest(): FindRequest | null {
  const f = useFind.getState();
  return f.query
    ? {
        query: f.query,
        matchDiacritics: f.matchDiacritics,
        entireWord: f.entireWord,
        caseSensitive: f.caseSensitive,
        type: '',
      }
    : null;
}

export function Viewer({ doc }: { doc: DocTab }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const partsRef = useRef<Parts | null>(null);
  const locationRef = useRef<ViewState['location']>(currentView(doc.id).location);
  const { pdf, error } = usePdfDocument(doc);
  const tool = useUi((s) => s.tool);
  const findOpen = useUi((s) => s.findOpen);
  const night = useViewStore((s) => s.views[doc.id]?.night ?? false);
  const [ready, setReady] = useState(false);
  const docId = doc.id;

  // Create the pdf.js viewer once per mounted document.
  useEffect(() => {
    const container = containerRef.current!;
    const inner = innerRef.current!;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: 2 /* LinkTarget.BLANK */,
    });
    const findController = new ChefFindController({
      eventBus,
      linkService,
      updateMatchesCountOnProgress: true,
    });
    const viewer = new PDFViewer({
      container,
      viewer: inner,
      eventBus,
      linkService,
      findController,
      // Keep pdf.js' page-border mode: its fit-width maths then leaves a margin around pages (borders are restyled in Viewer.css).
      removePageBorders: false,
      textLayerMode: 1,
      annotationMode: AnnotationMode.ENABLE,
      enableAutoLinking: true,
    });
    linkService.setViewer(viewer);
    partsRef.current = { viewer, linkService, eventBus, findController };
    const patch = (p: Partial<ViewState>) => useViewStore.getState().patch(docId, p);

    eventBus.on('pagesinit', () => {
      const view = currentView(docId);
      const mode = MODE_TO_PDFJS[view.mode];
      viewer.scrollMode = mode.scroll;
      viewer.spreadMode = mode.spread;
      viewer.pagesRotation = view.rotation;
      viewer.currentScaleValue = view.scaleValue || 'auto';
      const loc = locationRef.current;
      if (loc && loc.page <= viewer.pagesCount) {
        viewer.scrollPageIntoView({
          pageNumber: loc.page,
          destArray: [null, { name: 'XYZ' }, loc.left, loc.top, null],
          allowNegativeOffset: true,
          ignoreDestinationZoom: true,
        });
      } else if (view.page > 1) {
        viewer.currentPageNumber = Math.min(view.page, viewer.pagesCount);
      }
      patch({ pageCount: viewer.pagesCount, page: viewer.currentPageNumber });
      setReady(true);
      // Re-run an active search on the new revision.
      const req = lastFindRequest();
      if (req && useUi.getState().findOpen)
        eventBus.dispatch('find', {
          source: null,
          ...req,
          highlightAll: true,
          findPrevious: false,
        });
    });
    eventBus.on('pagechanging', (e: { pageNumber: number }) => patch({ page: e.pageNumber }));
    eventBus.on('scalechanging', (e: { scale: number; presetValue?: string }) =>
      patch({ scale: e.scale, scaleValue: e.presetValue ?? String(e.scale) }),
    );
    eventBus.on('rotationchanging', (e: { pagesRotation: number }) =>
      patch({ rotation: (e.pagesRotation % 360) as ViewState['rotation'] }),
    );
    eventBus.on(
      'updateviewarea',
      (e: { location: { pageNumber: number; left: number; top: number } }) => {
        locationRef.current = {
          page: e.location.pageNumber,
          left: e.location.left,
          top: e.location.top,
        };
      },
    );
    eventBus.on(
      'updatefindmatchescount',
      (e: { matchesCount: { current: number; total: number } }) =>
        useFind.getState().set({ current: e.matchesCount.current, total: e.matchesCount.total }),
    );
    eventBus.on(
      'updatefindcontrolstate',
      (e: { state: number; matchesCount: { current: number; total: number } }) =>
        useFind.getState().set({
          status: statusFromPdfjs(e.state),
          current: e.matchesCount.current,
          total: e.matchesCount.total,
        }),
    );

    const unregister = registerViewer(docId, {
      goToPage: (n) => {
        if (viewer.pagesCount)
          viewer.currentPageNumber = Math.max(1, Math.min(viewer.pagesCount, n));
      },
      goToDest: (dest) => void linkService.goToDestination(dest as string),
      setScaleValue: (v) => {
        viewer.currentScaleValue = v;
      },
      zoomBy: (dir) => {
        viewer.currentScale = nextZoom(viewer.currentScale, dir);
      },
      rotateBy: (delta) => {
        viewer.pagesRotation = (viewer.pagesRotation + delta + 360) % 360;
      },
      setMode: (mode) => {
        patch({ mode });
        const m = MODE_TO_PDFJS[mode];
        viewer.scrollMode = m.scroll;
        viewer.spreadMode = m.spread;
      },
      find: (req) =>
        eventBus.dispatch('find', {
          source: null,
          type: req.type,
          query: req.query,
          caseSensitive: req.caseSensitive,
          entireWord: req.entireWord,
          matchDiacritics: req.matchDiacritics,
          highlightAll: true,
          findPrevious: !!req.findPrevious,
        }),
      closeFind: () => eventBus.dispatch('findbarclose', { source: null }),
      container: () => containerRef.current,
    });

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      viewer.currentScale = nextZoom(viewer.currentScale, e.deltaY < 0 ? 1 : -1);
    };
    container.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', onWheel);
      unregister();
      if (locationRef.current) patch({ location: locationRef.current });
      viewer.setDocument(null as unknown as PDFDocumentProxy);
      linkService.setDocument(null);
      partsRef.current = null;
    };
  }, [docId]);

  // (Re)load the document when the revision changes; position is restored in 'pagesinit'.
  useEffect(() => {
    const parts = partsRef.current;
    if (!parts || !pdf || parts.viewer.pdfDocument === pdf) return;
    parts.viewer.setDocument(pdf);
    parts.linkService.setDocument(pdf, null);
  }, [pdf]);

  useEffect(() => {
    if (!findOpen) partsRef.current?.eventBus.dispatch('findbarclose', { source: null });
  }, [findOpen]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const v = partsRef.current?.viewer;
    if (!v || e.ctrlKey || e.metaKey || e.altKey) return;
    // Single-page mode has nothing to scroll: keys flip pages. Continuous modes scroll natively.
    const single = v.scrollMode === ScrollMode.PAGE;
    if (single && ['PageDown', 'ArrowRight', 'ArrowDown', ' '].includes(e.key)) {
      e.preventDefault();
      v.nextPage();
    } else if (single && ['PageUp', 'ArrowLeft', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      v.previousPage();
    } else if (e.key === 'Home') {
      e.preventDefault();
      getViewer(docId)?.goToPage(1);
    } else if (e.key === 'End') {
      e.preventDefault();
      getViewer(docId)?.goToPage(v.pagesCount);
    }
  };

  const copySelection = () => {
    const text = window.getSelection()?.toString() ?? '';
    if (text) void chef().clipboard.writeText(text);
  };

  const menu = [
    {
      id: 'copy',
      label: t('viewer.copyText'),
      icon: <Copy size={15} />,
      shortcut: 'Mod+C',
      onSelect: copySelection,
    },
    {
      id: 'snapshot',
      label: t('viewer.snapshot'),
      icon: <Crop size={15} />,
      onSelect: () => useUi.getState().set({ tool: 'snapshot' }),
    },
    {
      id: 'select',
      label: t('viewer.selectText'),
      icon: <ScanText size={15} />,
      onSelect: () => useUi.getState().set({ tool: 'select' }),
    },
    { type: 'separator' as const, id: 's1' },
    {
      id: 'rotate',
      label: t('viewer.rotateView'),
      icon: <RotateCw size={15} />,
      onSelect: () => getViewer(docId)?.rotateBy(90),
    },
    {
      id: 'props',
      label: t('viewer.properties'),
      icon: <Info size={15} />,
      onSelect: () => useUi.getState().openDialog('properties'),
    },
  ];

  return (
    <div className="viewer" data-tool={tool} data-night={night}>
      {doc.busy > 0 && (
        <div className="viewer__busy">
          <ProgressBar value={null} label={t('jobs.running')} />
        </div>
      )}
      {findOpen && <FindBar docId={doc.id} />}
      <ContextMenu entries={menu}>
        <div
          ref={containerRef}
          className="viewer__scroll"
          tabIndex={0}
          role="document"
          aria-label={t('viewer.region', { name: doc.name })}
          onKeyDown={onKeyDown}
        >
          <div ref={innerRef} className="pdfViewer" />
        </div>
      </ContextMenu>
      {tool === 'snapshot' && <SnapshotLayer getContainer={() => containerRef.current} />}
      <PlacementOverlay doc={doc} getContainer={() => containerRef.current} />
      <OverlayPlacementLayer doc={doc} getContainer={() => containerRef.current} />
      <HighlightLayer doc={doc} getContainer={() => containerRef.current} />
      <ObjectLayer doc={doc} getContainer={() => containerRef.current} />
      <EraseLayer doc={doc} getContainer={() => containerRef.current} />
      <TextEditLayer doc={doc} getContainer={() => containerRef.current} />
      <LinkDrawLayer doc={doc} getContainer={() => containerRef.current} />
      <FormDrawLayer doc={doc} getContainer={() => containerRef.current} />
      <AnnotLayer doc={doc} getContainer={() => containerRef.current} />
      {!ready && !error && (
        <div className="viewer__center">
          <Spinner size={22} label={t('viewer.loading')} />
        </div>
      )}
      {error && !pdf && (
        <div className="viewer__center">
          <EmptyState title={t('viewer.loadFailed')} text={error} />
        </div>
      )}
    </div>
  );
}
