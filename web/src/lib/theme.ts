export type ThemeScheme = 'light' | 'dark';

export function detectThemeFromRoot(): ThemeScheme {
  if (typeof document === 'undefined') return 'light';
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (!getComputedStyle(document.documentElement).getPropertyValue('--background').trim()) return systemTheme;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
  document.documentElement.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();

  const nums = (computed.match(/[\d.]+/g) || []).map(Number);
  if (nums.length < 3) {
    return systemTheme;
  }
  const scale = computed.startsWith('color(') ? 1 : 255;
  const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum < 0.5 ? 'dark' : 'light';
}

export function syncThemeAttribute(): ThemeScheme {
  const theme = detectThemeFromRoot();
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
  }
  return theme;
}

export function startThemeObserver(onChange?: (theme: ThemeScheme) => void): () => void {
  const apply = () => {
    const next = syncThemeAttribute();
    onChange?.(next);
  };
  apply();

  const observer = new MutationObserver(() => apply());
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const onMediaChange = () => apply();
  media?.addEventListener?.('change', onMediaChange);

  return () => {
    observer.disconnect();
    media?.removeEventListener?.('change', onMediaChange);
  };
}
