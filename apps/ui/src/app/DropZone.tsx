import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDown } from 'lucide-react';
import { pathsForDroppedFiles } from '../lib/bridge';
import { toast } from '../components/Toast';
import { openFiles } from './actions';

function hasFiles(e: DragEvent) {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}

/** Window-wide drop target: drop PDF files anywhere to open them. */
export function DropZone() {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setActive(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      const handled = e.defaultPrevented;
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      if (handled) return;
      const files = [...(e.dataTransfer?.files ?? [])];
      const pdfs = files.filter(
        (f) => f.name.toLowerCase().endsWith('.pdf') || f.type === 'application/pdf',
      );
      if (pdfs.length < files.length) toast.info(t('drop.onlyPdf'));
      void pathsForDroppedFiles(pdfs).then((paths) => {
        if (pdfs.length && !paths.length) toast.error(t('drop.unsupported'));
        return openFiles(paths);
      });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [t]);

  if (!active) return null;
  return (
    <div className="dropzone" aria-hidden>
      <div className="dropzone__card">
        <FileDown size={30} />
        <span>{t('drop.title')}</span>
      </div>
    </div>
  );
}
