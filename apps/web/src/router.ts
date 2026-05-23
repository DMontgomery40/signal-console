// Tiny in-app router (US-047). The scaffold's App.tsx already listens to
// `popstate` to re-read window.location.pathname. `history.pushState` does
// NOT fire popstate, so navigations from inside the app need to dispatch it
// manually for the App to re-render.
//
// We keep the surface to a single helper: pass an anchor click event + href,
// and the helper either lets the browser handle the click (modifier keys
// pressed - new tab / window) or does pushState + popstate dispatch.
//
// Real anchors (with href) are used everywhere, so middle-click / cmd-click
// always open in a new tab regardless of this helper.

export function navigateTo(event: React.MouseEvent<HTMLAnchorElement>, href: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (event.button !== 0) return;
  event.preventDefault();
  window.history.pushState({}, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// Extract :gameId from /games/:gameId. Returns null if the path doesn't match.
// Falsey-empty match (/games/ alone) returns null so the caller renders an
// invalid-id fallback instead of an unbounded query.
export function parseGameId(path: string): string | null {
  const m = /^\/games\/([^/?#]+)/.exec(path);
  if (m === null) return null;
  const raw = m[1];
  if (raw === undefined || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Extract :id from /live/:id (US-031). Returns null for the bare /live path so
// the caller renders the "click a Recent row to open Live" placeholder rather
// than firing an unbounded query.
export function parseLiveId(path: string): string | null {
  const m = /^\/live\/([^/?#]+)/.exec(path);
  if (m === null) return null;
  const raw = m[1];
  if (raw === undefined || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
