/**
 * Photo layer: read the manifest, preload, and crossfade a slideshow.
 *
 * Two stacked <img> elements alternate as front/back; we preload the next
 * image, then swap opacity for the crossfade. Photos are object-fit:cover for
 * the 1280x800 panel, ordered by `ts`, with an optional slow Ken Burns drift.
 * A small sender chip + caption is shown per photo.
 */

import { PATHS, SLIDESHOW } from "./config";

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
let kenBurns = SLIDESHOW.KEN_BURNS;

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

function applyKenBurns(el: HTMLImageElement): void {
  el.classList.remove("kenburns");
  if (!kenBurns) return;
  // Restart the animation by forcing reflow, then re-add the class.
  // Randomize direction a little so consecutive photos differ.
  void el.offsetWidth;
  el.style.setProperty("--kb-x", (Math.random() * 4 - 2).toFixed(2) + "%");
  el.style.setProperty("--kb-y", (Math.random() * 4 - 2).toFixed(2) + "%");
  el.classList.add("kenburns");
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
    applyKenBurns(back);

    // Update caption/chip for the incoming photo.
    const chip = chipEl();
    const cap = captionEl();
    const meta = metaEl();
    if (chip) chip.textContent = entry.uploader || "";
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
  timer = window.setInterval(advance, SLIDESHOW.INTERVAL_MS);
}

export function toggleKenBurns(): boolean {
  kenBurns = !kenBurns;
  return kenBurns;
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
