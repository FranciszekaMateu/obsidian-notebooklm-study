import { ES } from "./i18n-es";

/*
 * UI strings are written in English and looked up in a per-language table.
 * `{name}` placeholders are filled from `vars`. Missing translations fall
 * back to English, so a forgotten key never breaks the UI.
 */

export type Language = "en" | "es";
export type LanguagePref = "auto" | Language;

let current: Language = "en";

export function setLanguage(pref: LanguagePref) {
    if (pref !== "auto") {
        current = pref;
        return;
    }
    let ui = "en";
    try {
        // Obsidian stores the interface language here ("es", "en", …); unset means English.
        ui = window.localStorage.getItem("language") || "en";
    } catch {
        // storage unavailable
    }
    current = ui.toLowerCase().startsWith("es") ? "es" : "en";
}

export function language(): Language {
    return current;
}

/** BCP-47 tag for dates and numbers. */
export function locale(): string {
    return current === "es" ? "es" : "en";
}

export function t(text: string, vars?: Record<string, string | number>): string {
    let s = current === "es" ? ES[text] ?? text : text;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
    return s;
}

/** Singular / plural pick: tn(n, "{n} card", "{n} cards"). */
export function tn(n: number, one: string, other: string, vars: Record<string, string | number> = {}): string {
    return t(n === 1 ? one : other, { n, ...vars });
}
