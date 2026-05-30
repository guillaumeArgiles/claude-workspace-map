import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { SUPPORTED_LOCALES, type Locale } from "../../shared/config-schema";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";

type Dict = Record<string, string>;
const DICTS: Record<Locale, Dict> = { en, fr, es };

// Module-level singleton — lets non-React code (Phaser scenes, UI bus
// handlers) read and react to the current locale without holding a hook.
let currentLocale: Locale = "en";
const listeners = new Set<(loc: Locale) => void>();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(loc: Locale): void {
  if (!SUPPORTED_LOCALES.includes(loc) || loc === currentLocale) return;
  currentLocale = loc;
  listeners.forEach((cb) => cb(loc));
}

export function subscribeLocale(cb: (loc: Locale) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function lookup(loc: Locale, key: string): string {
  return DICTS[loc]?.[key] ?? DICTS.en[key] ?? key;
}

function interpolate(
  str: string,
  params?: Record<string, string | number>
): string {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) =>
    k in params ? String(params[k]) : `{${k}}`
  );
}

export function t(
  key: string,
  params?: Record<string, string | number>,
  loc?: Locale
): string {
  return interpolate(lookup(loc ?? currentLocale, key), params);
}

/**
 * Pick the right plural form of `base` for `n`. Looks up keys like
 * `base.one`, `base.other` (and other CLDR categories) in the current
 * locale's dict, with fallbacks to `.other` then English.
 */
export function plural(
  n: number,
  base: string,
  params?: Record<string, string | number>,
  loc?: Locale
): string {
  const locale = loc ?? currentLocale;
  const cat = new Intl.PluralRules(locale).select(n);
  const tryKeys = [`${base}.${cat}`, `${base}.other`];
  for (const k of tryKeys) {
    const hit = DICTS[locale]?.[k] ?? DICTS.en[k];
    if (hit !== undefined) return interpolate(hit, { ...params, count: n });
  }
  return interpolate(base, { ...params, count: n });
}

export function formatNumber(n: number, loc?: Locale): string {
  return new Intl.NumberFormat(loc ?? currentLocale).format(n);
}

export function formatCompact(n: number, loc?: Locale): string {
  return new Intl.NumberFormat(loc ?? currentLocale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const lang = navigator.language?.slice(0, 2).toLowerCase();
  return (SUPPORTED_LOCALES as readonly string[]).includes(lang)
    ? (lang as Locale)
    : "en";
}

// ── React surface ──────────────────────────────────────────────────────────

interface I18nCtx {
  locale: Locale;
  t: (key: string, params?: Record<string, string | number>) => string;
  plural: (
    n: number,
    base: string,
    params?: Record<string, string | number>
  ) => string;
  formatNumber: (n: number) => string;
  formatCompact: (n: number) => string;
  setLocale: (loc: Locale) => void;
}

const Ctx = createContext<I18nCtx | null>(null);

interface I18nProviderProps {
  initialLocale: Locale;
  children: ReactNode;
}

export function I18nProvider({ initialLocale, children }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  // Sync the module singleton on first paint so non-React readers see the
  // correct value before any setLocale() call.
  if (currentLocale !== locale) currentLocale = locale;

  // Subscribe to module-level changes (e.g. someone calling setLocale() from
  // outside React). Keep this -> React state in sync.
  useEffect(() => subscribeLocale((loc) => setLocaleState(loc)), []);

  const change = useCallback((loc: Locale) => {
    setLocale(loc);
  }, []);

  const value = useMemo<I18nCtx>(
    () => ({
      locale,
      t: (k, p) => t(k, p, locale),
      plural: (n, base, p) => plural(n, base, p, locale),
      formatNumber: (n) => formatNumber(n, locale),
      formatCompact: (n) => formatCompact(n, locale),
      setLocale: change,
    }),
    [locale, change]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTranslation(): I18nCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTranslation must be used inside <I18nProvider>");
  return v;
}
