import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import './app/styles/tokens.css';
import './app/styles/base.css';
import './components/components.css';
import { i18n } from './i18n';
import { initBridge } from './lib/bridge';
import { applyTheme } from './app/theme';
import { App } from './app/App';
import { useUi } from './app/state/ui';

// Test hook for e2e (ui-audit): lets Playwright open any dialog or tab via getState()/openDialog().
(window as unknown as { __chefUi?: typeof useUi }).__chefUi = useUi;

async function main() {
  const root = createRoot(document.getElementById('root')!);
  try {
    await initBridge();
  } catch (e) {
    root.render(<p style={{ padding: 24 }}>{i18n.t('errors.noBridge', { message: String(e) })}</p>);
    return;
  }
  applyTheme('system');
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void main();
