/**
 * Photo layer: read the manifest, preload, and crossfade a slideshow.
 *
 * Two stacked <img> elements alternate as front/back; we preload the next
 * image, then swap opacity for the crossfade. Images are fully static (no
 * zoom/pan) — object-fit:cover fills the 1280x800 panel by default, except
 * when a photo's aspect ratio deviates significantly from the screen's, in
 * which case it's letterboxed/pillarboxed in black instead of cropped (see
 * pickFit()). A small sender chip + caption is shown per photo.
 *
 * `entries` holds the full manifest (ts-ascending, for the gallery). The
 * always-on slideshow only cycles a subset — `rotation` — of every
 * `favourite` photo (regardless of age) plus the 10 newest non-favourites,
 * shuffled together and reshuffled on every full pass (see computeRotation()
 * / rebuildRotation()) so it doesn't feel like a fixed loop.
 */

import { PATHS, SLIDESHOW, UPLOADER, favouriteUrl } from "./config";
import { formatShortDate } from "./format";

export interface ManifestEntry {
  id: string;
  file: string;
  uploader: string;
  caption: string;
  channel: string;
  ts: string;
  w: number;
  h: number;
  /** Defaults to false — additive field, older manifest entries may lack it. */
  favourite: boolean;
  /** Filename in thumbs/ for the gallery grid; "" if not generated (yet). */
  thumb: string;
}

/** Full manifest, ts-ascending — the gallery's source list. */
let entries: ManifestEntry[] = [];
/** Shuffled always-on rotation subset the slideshow actually cycles through. */
let rotation: ManifestEntry[] = [];
let idx = 0;
let frontIsA = true;
let showing = false;       // a show() is mid-flight (preload + crossfade)
let timer = 0;             // advance interval
let refreshTimer = 0;      // manifest re-poll interval
let paused = false;        // auto-advance halted via the pause/play control
let galleryOpen = false;   // auto-advance halted while the gallery/lightbox is open

const imgA = () => document.getElementById("photo-a") as HTMLImageElement;
const imgB = () => document.getElementById("photo-b") as HTMLImageElement;
const metaEl = () => document.getElementById("photo-meta") as HTMLElement;
const chipEl = () => document.getElementById("sender-chip") as HTMLElement;
const captionEl = () => document.getElementById("caption") as HTMLElement;

export function photoUrl(file: string): string {
  return `${PATHS.PHOTOS_BASE}/${file}`;
}

export function thumbUrl(file: string): string {
  return `${PATHS.THUMBS_BASE}/${file}`;
}

const RECENT_NON_FAVOURITE_COUNT = 10;

/** #caption is a 420px-wide, 32px/500, 3-line-clamped box (see styles.css) —
 *  measured against the actual font stack, that width fits ~26 chars per
 *  wrapped line, so 78 chars is roughly a full 3 lines. The CSS line-clamp
 *  is the real visual backstop; this cap just keeps arbitrarily long
 *  captions out of the DOM/measurement work. */
const CAPTION_MAX_CHARS = 78;

function truncateCaption(caption: string): string {
  if (caption.length <= CAPTION_MAX_CHARS) return caption;
  return `${caption.slice(0, CAPTION_MAX_CHARS - 1).trimEnd()}…`;
}

function shuffle<T>(list: T[]): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** All favourites (any age) + the 10 newest non-favourites, shuffled
 *  together (not segregated) so favourites and recents interleave. */
function computeRotation(list: ManifestEntry[]): ManifestEntry[] {
  const favourites = list.filter((e) => e.favourite);
  const favIds = new Set(favourites.map((e) => e.id));
  const nonFavourites = list
    .filter((e) => !favIds.has(e.id))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts))); // newest first
  const recent = nonFavourites.slice(0, RECENT_NON_FAVOURITE_COUNT);
  return shuffle([...favourites, ...recent]);
}

/** Recompute the rotation from the current `entries` and reshuffle it.
 *  Called on load, on every manifest refresh, on a favourite toggle, and
 *  when a full pass completes (see advance()) — membership can change any
 *  of those times, so a fresh shuffle each time is simpler than patching an
 *  existing array in place, and still satisfies "reshuffled each pass"
 *  (pass completion always triggers this). Keeps showing the same photo
 *  (by id) if it's still in the new rotation; otherwise restarts at 0. */
function rebuildRotation(preserveId?: string): void {
  rotation = computeRotation(entries);
  if (rotation.length === 0) {
    idx = 0;
    return;
  }
  const found = preserveId ? rotation.findIndex((e) => e.id === preserveId) : -1;
  idx = found >= 0 ? found : 0;
}

function preload(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => resolve(); // never block the slideshow on a bad file
    img.src = url;
  });
}

/** cover (fill, cropped) unless the photo's aspect ratio deviates significantly
 *  from the screen's, in which case contain (letterbox/pillarbox in black). */
function pickFit(w: number, h: number): "cover" | "contain" {
  if (!w || !h) return "cover";
  const ratio = w / h;
  const deviation = Math.abs(ratio - SLIDESHOW.SCREEN_RATIO) / SLIDESHOW.SCREEN_RATIO;
  return deviation > SLIDESHOW.ASPECT_DEVIATION_THRESHOLD ? "contain" : "cover";
}

function applyFit(el: HTMLImageElement, entry: ManifestEntry): void {
  const contain = pickFit(entry.w, entry.h) === "contain";
  el.classList.toggle("fit-contain", contain);
  el.classList.toggle("fit-cover", !contain);
}

async function show(entry: ManifestEntry): Promise<void> {
  // Guard against re-entrancy: if a previous show() is still preloading (slow
  // network on the old WebView), skip rather than interleave two crossfades —
  // overlapping shows would desync the front/back swap and mismatch captions.
  if (showing) return;
  showing = true;
  try {
    const url = photoUrl(entry.file);
    await preload(url);

    const back = frontIsA ? imgB() : imgA();
    const front = frontIsA ? imgA() : imgB();
    if (!back || !front) return;

    back.src = url;
    applyFit(back, entry);

    // Update caption/chip for the incoming photo. The chip line is
    // "uploader · D Mon" (either half optional); the caption is the message.
    const chip = chipEl();
    const cap = captionEl();
    const meta = metaEl();
    const ts = new Date(entry.ts);
    const dateStr = Number.isNaN(ts.getTime()) ? "" : formatShortDate(ts);
    if (chip) chip.textContent = [entry.uploader, dateStr].filter(Boolean).join(" · ");
    if (cap) cap.textContent = truncateCaption(entry.caption || "");
    if (meta) meta.style.display = entry.uploader || entry.caption ? "flex" : "none";

    // Crossfade: bring back to front.
    back.classList.add("is-front");
    front.classList.remove("is-front");
    frontIsA = !frontIsA;
  } finally {
    showing = false;
  }
}

function advance(): void {
  if (rotation.length === 0 || showing) return;
  idx += 1;
  if (idx >= rotation.length) {
    // Completed a full pass: reshuffle for the next one.
    rebuildRotation();
  }
  void show(rotation[idx]);
}

function schedule(): void {
  if (timer) window.clearInterval(timer);
  timer = 0;
  if (paused || galleryOpen) return;
  timer = window.setInterval(advance, SLIDESHOW.INTERVAL_MS);
}

/** True while auto-advance is halted via the pause/play control. */
export function isPaused(): boolean {
  return paused;
}

/** Pause/resume auto-advance (pause/play toggle button). Returns the new paused state. */
export function togglePause(): boolean {
  paused = !paused;
  schedule();
  return paused;
}

/** Skip/back buttons: jump immediately and reset the auto-advance countdown. */
export function stepPhoto(delta: 1 | -1): void {
  if (rotation.length === 0 || showing) return;
  idx = (idx + delta + rotation.length) % rotation.length;
  void show(rotation[idx]);
  schedule();
}

/** Halt auto-advance while the gallery/lightbox is open (separate from the
 *  user-facing pause/play toggle, so opening/closing the gallery doesn't
 *  clobber a pause the user already set). */
export function pauseForGallery(): void {
  galleryOpen = true;
  schedule();
}

/** Resume auto-advance when the gallery/lightbox closes (no-op if the user
 *  had separately paused via the pause/play control — schedule() checks both). */
export function resumeFromGallery(): void {
  galleryOpen = false;
  schedule();
}

/** The photo currently on screen in the main slideshow, or null before the
 *  first photo has loaded. */
export function getCurrentEntry(): ManifestEntry | null {
  return rotation[idx] || null;
}

/** Full manifest (every photo, favourite or not) for the gallery grid. */
export function getAllEntries(): ManifestEntry[] {
  return entries.slice();
}

function normalizeEntry(e: Partial<ManifestEntry>): ManifestEntry {
  return {
    id: String(e.id || ""),
    file: String(e.file || ""),
    uploader: String(e.uploader || ""),
    caption: String(e.caption || ""),
    channel: String(e.channel || ""),
    ts: String(e.ts || ""),
    w: Number(e.w) || 0,
    h: Number(e.h) || 0,
    // Additive fields (see CLAUDE.md): tolerate older entries missing them.
    favourite: e.favourite === true,
    thumb: typeof e.thumb === "string" ? e.thumb : "",
  };
}

/** Fetch + sort the manifest. Returns null on failure (keep what we have). */
async function fetchManifest(): Promise<ManifestEntry[] | null> {
  try {
    const res = await fetch(PATHS.MANIFEST, { cache: "no-cache" });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const data = (await res.json()) as Partial<ManifestEntry>[];
    const list = Array.isArray(data) ? data.map(normalizeEntry) : [];
    // Order by ts ascending — a stable base list; the rotation shuffles its
    // own subset independently (see computeRotation()).
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return list;
  } catch (err) {
    console.warn("[photos] manifest fetch failed; SW cache may serve it", err);
    return null;
  }
}

/** Adopt a refreshed manifest, preserving the current photo by id if it's
 *  still in the rotation. */
function applyEntries(list: ManifestEntry[]): void {
  const wasEmpty = entries.length === 0;
  const currentId = rotation[idx] ? rotation[idx].id : undefined;
  entries = list;
  rebuildRotation(currentId);
  // If we previously had nothing on screen, start the show now.
  if (wasEmpty && rotation.length > 0) {
    void show(rotation[idx]);
    schedule();
  }
}

/** Load (or reload) the manifest and (re)start the slideshow. */
export async function startSlideshow(): Promise<void> {
  const list = await fetchManifest();
  if (list) entries = list;

  rebuildRotation();
  if (rotation.length > 0) {
    await show(rotation[idx]);
    schedule();
  } else {
    console.warn("[photos] no photos in manifest yet; will keep polling");
  }

  // Re-poll so photos added by the processor after boot appear without a
  // reload (the frame is always-on).
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => void refreshManifest(), SLIDESHOW.MANIFEST_REFRESH_MS);
}

/** Periodic manifest re-poll: adopt new/removed photos without a reload. */
async function refreshManifest(): Promise<void> {
  const list = await fetchManifest();
  if (list) applyEntries(list);
}

function favouriteHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (UPLOADER.TOKEN) headers["X-Upload-Token"] = UPLOADER.TOKEN;
  return headers;
}

/** Recompute rotation membership from `entries`, but only actually replace
 *  (and reshuffle) `rotation` if the set of ids changed — e.g. a favourite
 *  toggle that doesn't move a photo in or out of the rotation set leaves the
 *  current shuffled order untouched, so a single heart tap doesn't visibly
 *  reorder unrelated photos. When membership DOES change, delegates to
 *  rebuildRotation() (a fresh shuffle is appropriate there — the set itself
 *  is new). Contrast with rebuildRotation(), which always reshuffles and is
 *  used where that's the point (a full pass completing, a manifest refresh). */
function syncRotationMembership(preserveId?: string): void {
  const next = computeRotation(entries);
  const currentIds = new Set(rotation.map((e) => e.id));
  const sameMembership = next.length === rotation.length && next.every((e) => currentIds.has(e.id));
  if (sameMembership) {
    if (preserveId) {
      const found = rotation.findIndex((e) => e.id === preserveId);
      if (found >= 0) idx = found;
    }
    return;
  }
  rebuildRotation(preserveId);
}

// Per-id request counter so an older, slower response can never clobber a
// newer toggle of the same photo — see toggleFavourite().
const favouriteRequestGen = new Map<string, number>();

/**
 * Optimistically flip `favourite` on the entry with this id, POST it to the
 * frame-uploader add-on, and reconcile with the server's response — reverts
 * on failure. If the uploader isn't configured (dev/mock, or a box that
 * hasn't set up the mapped-port fallback — see config.ts's `favouriteUrl()`),
 * the optimistic update is treated as final, same spirit as the AC controls'
 * dev-mode no-op in data.ts. Returns the final favourite state so the caller
 * (overlay.ts's heart button, gallery.ts's grid/lightbox) can update its icon.
 *
 * Safe against overlapping calls for the same id (e.g. a fast double-tap): a
 * generation counter per id means only the response to the MOST RECENT
 * request may write back, so a slower, older request's response can't undo a
 * newer toggle. Reconciliation also re-looks-up the entry by id (rather than
 * closing over the original object) so a manifest refresh that replaced
 * `entries` mid-flight doesn't leave the result applied to an orphaned copy.
 */
export async function toggleFavourite(id: string): Promise<boolean> {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;
  const prev = entry.favourite;
  entry.favourite = !prev;

  const gen = (favouriteRequestGen.get(id) || 0) + 1;
  favouriteRequestGen.set(id, gen);

  const url = favouriteUrl();
  if (url) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: favouriteHeaders(),
        body: JSON.stringify({ id, value: entry.favourite }),
      });
      if (!res.ok) throw new Error(`favourite ${res.status}`);
      const updated = (await res.json()) as Partial<ManifestEntry>;
      if (favouriteRequestGen.get(id) === gen) {
        const live = entries.find((e) => e.id === id);
        if (live) live.favourite = updated.favourite === true;
      }
    } catch (err) {
      console.warn("[photos] favourite toggle failed; reverting", err);
      if (favouriteRequestGen.get(id) === gen) {
        const live = entries.find((e) => e.id === id);
        if (live) live.favourite = prev;
      }
    }
  }

  syncRotationMembership(rotation[idx] ? rotation[idx].id : undefined);
  return entries.find((e) => e.id === id)?.favourite ?? entry.favourite;
}
