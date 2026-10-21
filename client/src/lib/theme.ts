const STORAGE_KEY = 'theme';

/**
 * The app is light-only: it never follows the OS prefers-color-scheme and has no dark toggle.
 * Removes the `dark` class and clears a 'dark' choice saved by the old theme toggle. The `.dark`
 * tokens stay in index.css but are unused.
 */
export function applyLightTheme(): void {
  document.documentElement.classList.remove('dark');
  try {
    if (localStorage.getItem(STORAGE_KEY) !== null) localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode / blocked) - nothing to clear
  }
}
