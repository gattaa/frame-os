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
let timer = 0;
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
}

function advance(): void {
  if (entries.length === 0) return;
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

/** Load (or reload) the manifest and (re)start the slideshow. */
export async function startSlideshow(): Promise<void> {
  try {
    const res = await fetch(PATHS.MANIFEST, { cache: "no-cache" });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const data = (await res.json()) as ManifestEntry[];
    entries = Array.isArray(data) ? data.slice() : [];
  } catch (err) {
    console.warn("[photos] manifest fetch failed; SW cache may serve it", err);
    // If fetch failed entirely we keep whatever we had; on first load this is [].
  }

  // Order by ts ascending for a stable, chronological slideshow.
  entries.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  if (entries.length === 0) {
    console.warn("[photos] no photos in manifest");
    return;
  }
  idx = 0;
  await show(entries[idx]);
  schedule();
}
