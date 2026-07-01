/**
 * Photo layer: read the manifest, preload, and crossfade a slideshow.
 *
 * Two stacked <img> elements alternate as front/back; we preload the next
 * image, then swap opacity for the crossfade. Images are fully static (no
 * zoom/pan) — object-fit:cover fills the 1280x800 panel by default, except
 * when a photo's aspect ratio deviates significantly from the screen's, in
 * which case it's letterboxed/pillarboxed in black instead of cropped (see
 * pickFit()). Ordered by `ts`. A small sender chip + caption is shown per
 * photo.
 */

import { PATHS, SLIDESHOW } from "./config";
import { formatShortDate } from "./format";

interface ManifestEntry {
  id: string;
  file: string;
  uploader: string;
  caption: string;
  channel: string;
  ts: string;
  w: number;
  h: number;
}

let entries: ManifestEntry[] = [];
let idx = 0;
let frontIsA = true;
let showing = false;       // a show() is mid-flight (preload + crossfade)
let timer = 0;             // advance interval
let refreshTimer = 0;      // manifest re-poll interval
let paused = false;        // auto-advance halted via the pause/play control

const imgA = () => document.getElementById("photo-a") as HTMLImageElement;
const imgB = () => document.getElementById("photo-b") as HTMLImageElement;
const metaEl = () => document.getElementById("photo-meta") as HTMLElement;
const chipEl = () => document.getElementById("sender-chip") as HTMLElement;
const captionEl = () => document.getElementById("caption") as HTMLElement;

function photoUrl(file: string): string {
  return `${PATHS.PHOTOS_BASE}/${file}`;
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
    if (cap) cap.textContent = entry.caption || "";
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
  if (entries.length === 0 || showing) return;
  idx = (idx + 1) % entries.length;
  void show(entries[idx]);
}

function schedule(): void {
  if (timer) window.clearInterval(timer);
  timer = 0;
  if (paused) return;
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
  if (entries.length === 0 || showing) return;
  idx = (idx + delta + entries.length) % entries.length;
  void show(entries[idx]);
  schedule();
}

/** Fetch + sort the manifest. Returns null on failure (keep what we have). */
async function fetchManifest(): Promise<ManifestEntry[] | null> {
  try {
    const res = await fetch(PATHS.MANIFEST, { cache: "no-cache" });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const data = (await res.json()) as ManifestEntry[];
    const list = Array.isArray(data) ? data.slice() : [];
    // Order by ts ascending for a stable, chronological slideshow.
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    return list;
  } catch (err) {
    console.warn("[photos] manifest fetch failed; SW cache may serve it", err);
    return null;
  }
}

/** Adopt a refreshed manifest, preserving the current photo by id. */
function applyEntries(list: ManifestEntry[]): void {
  const wasEmpty = entries.length === 0;
  const currentId = entries.length > 0 ? entries[idx].id : undefined;
  entries = list;
  if (entries.length === 0) {
    idx = 0;
    return;
  }
  if (currentId) {
    const found = entries.findIndex((e) => e.id === currentId);
    idx = found >= 0 ? found : Math.min(idx, entries.length - 1);
  } else {
    idx = 0;
  }
  // If we previously had nothing on screen, start the show now.
  if (wasEmpty) {
    void show(entries[idx]);
    schedule();
  }
}

/** Load (or reload) the manifest and (re)start the slideshow. */
export async function startSlideshow(): Promise<void> {
  const list = await fetchManifest();
  if (list) entries = list;

  if (entries.length > 0) {
    idx = 0;
    await show(entries[idx]);
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
