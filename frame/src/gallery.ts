/**
 * Gallery: a full-screen, touch-scrollable grid of every photo in the
 * manifest, opened from the control layer's gallery button.
 *
 * The grid renders `thumb` images, never full-size photos — the point of
 * generating thumbnails at all is so this old WebView isn't asked to decode
 * dozens of full-res JPEGs at once (see CLAUDE.md hard constraints). Photos
 * are grouped into month sections (newest first) so a large library doesn't
 * read as one undifferentiated wall of thumbnails. Tapping a grid item's
 * heart toggles its favourite; tapping the photo itself opens it large (the
 * "lightbox") with the same sender/caption info as the main slideshow, plus
 * its own favourite toggle and a back control. The main slideshow's
 * auto-advance is paused for as long as the gallery (grid or lightbox) is
 * open, and resumes when the gallery is closed entirely.
 */

import { el, heartIconPath } from "./overlay";
import {
  getAllEntries, pauseForGallery, photoUrl, resumeFromGallery, thumbUrl, toggleFavourite,
} from "./photos";
import type { ManifestEntry } from "./photos";
import { formatShortDate } from "./format";

let isOpen = false;
let lightboxId: string | null = null;

const gridIcons = new Map<string, Element>();
const gridButtons = new Map<string, HTMLButtonElement>();

/** Push the (possibly optimistic) favourite state to every place this photo
 *  is currently rendered: its grid tile and, if open, the lightbox. */
function applyFavouriteState(id: string): void {
  const entry = getAllEntries().find((e) => e.id === id);
  if (!entry) return;
  const icon = gridIcons.get(id);
  const btn = gridButtons.get(id);
  if (icon) icon.innerHTML = heartIconPath(entry.favourite);
  if (btn) btn.setAttribute("aria-label", entry.favourite ? "Remove from favourites" : "Add to favourites");
  if (lightboxId === entry.id) renderLightboxFavourite(entry.favourite);
}

function handleToggle(id: string): void {
  // Synchronous optimistic mutation happens inside toggleFavourite() before
  // its first await, so rendering right after calling it (not after it
  // resolves) already reflects the optimistic state — see overlay.ts for
  // the same pattern on the main slideshow's heart button.
  const pending = toggleFavourite(id);
  applyFavouriteState(id);
  void pending.then(() => applyFavouriteState(id));
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** Sortable "YYYY-MM" grouping key; malformed timestamps all land in one
 *  "unknown" bucket rather than crashing or scattering across sections. */
function monthKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "July 2026" section heading for a given entry's timestamp. */
function monthLabel(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "Undated";
  return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

function buildGridItem(entry: ManifestEntry): HTMLElement {
  const item = document.createElement("div");
  item.className = "gallery-item";
  item.dataset.id = entry.id;

  const img = document.createElement("img");
  img.className = "gallery-item-img";
  img.loading = "lazy";
  img.alt = entry.caption || "";
  img.src = entry.thumb ? thumbUrl(entry.thumb) : photoUrl(entry.file);
  item.appendChild(img);

  const favBtn = document.createElement("button");
  favBtn.type = "button";
  favBtn.className = "gallery-item-fav";
  // heartIconPath() returns a bare <path>, meant to live inside an <svg> —
  // build that wrapper here (same pattern as the pre-built <svg> elements in
  // index.html that nav-favourite/lightbox-fav swap .innerHTML on).
  favBtn.innerHTML = `<svg class="gallery-item-fav-icon" viewBox="0 0 24 24">${heartIconPath(entry.favourite)}</svg>`;
  favBtn.setAttribute("aria-label", entry.favourite ? "Remove from favourites" : "Add to favourites");
  favBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't also open the lightbox
    handleToggle(entry.id);
  });
  item.appendChild(favBtn);

  const favIcon = favBtn.querySelector(".gallery-item-fav-icon");
  if (favIcon) gridIcons.set(entry.id, favIcon);
  gridButtons.set(entry.id, favBtn);

  item.addEventListener("click", () => openLightbox(entry.id));
  return item;
}

function buildMonthSection(label: string, items: ManifestEntry[]): HTMLElement {
  const section = document.createElement("div");
  section.className = "gallery-month-section";

  const heading = document.createElement("h2");
  heading.className = "gallery-month-heading";
  heading.textContent = label;
  section.appendChild(heading);

  const monthGrid = document.createElement("div");
  monthGrid.className = "gallery-month-grid";
  for (const entry of items) {
    monthGrid.appendChild(buildGridItem(entry));
  }
  section.appendChild(monthGrid);

  return section;
}

let lastGridKey = "";

function renderGrid(): void {
  const grid = el("gallery-grid");
  if (!grid) return;

  // Newest first — a more natural browsing order than the slideshow's
  // chronological/shuffled orders.
  const list = getAllEntries().sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  const cacheKey = list.map((e) => e.id).join(",");
  if (cacheKey === lastGridKey) {
    // Same photo set as last time the gallery was opened — resync favourite
    // state (it may have changed via the slideshow's heart button while the
    // gallery was closed) without tearing down and re-decoding every thumb.
    for (const entry of list) applyFavouriteState(entry.id);
    return;
  }
  lastGridKey = cacheKey;

  grid.innerHTML = "";
  gridIcons.clear();
  gridButtons.clear();

  // Group into month sections, in the same newest-first order as `list`.
  let sectionKey = "";
  let sectionItems: ManifestEntry[] = [];
  for (const entry of list) {
    const mKey = monthKey(entry.ts);
    if (mKey !== sectionKey) {
      if (sectionItems.length > 0) grid.appendChild(buildMonthSection(monthLabel(sectionItems[0].ts), sectionItems));
      sectionKey = mKey;
      sectionItems = [];
    }
    sectionItems.push(entry);
  }
  if (sectionItems.length > 0) grid.appendChild(buildMonthSection(monthLabel(sectionItems[0].ts), sectionItems));
}

// --- Lightbox (one photo, full size) ----------------------------------------

function renderLightboxFavourite(favourite: boolean): void {
  const icon = el("lightbox-fav-icon");
  const btn = el<HTMLButtonElement>("lightbox-fav-btn");
  if (icon) icon.innerHTML = heartIconPath(favourite);
  if (btn) btn.setAttribute("aria-label", favourite ? "Remove from favourites" : "Add to favourites");
}

/** Sender chip + caption, same "uploader · D Mon" / message pairing as the
 *  main slideshow's #photo-meta (see photos.ts's show()). */
function renderLightboxMeta(entry: ManifestEntry): void {
  const meta = el("lightbox-meta");
  const chip = el("lightbox-chip");
  const cap = el("lightbox-caption");
  const ts = new Date(entry.ts);
  const dateStr = Number.isNaN(ts.getTime()) ? "" : formatShortDate(ts);
  if (chip) chip.textContent = [entry.uploader, dateStr].filter(Boolean).join(" · ");
  if (cap) cap.textContent = entry.caption || "";
  if (meta) meta.style.display = entry.uploader || entry.caption ? "flex" : "none";
}

function openLightbox(id: string): void {
  const entry = getAllEntries().find((e) => e.id === id);
  if (!entry) return;
  lightboxId = id;
  const img = el<HTMLImageElement>("lightbox-img");
  if (img) img.src = photoUrl(entry.file);
  renderLightboxFavourite(entry.favourite);
  renderLightboxMeta(entry);
  el("lightbox-overlay")?.classList.add("open");
}

/** Back control: return to the grid (gallery itself stays open, slideshow
 *  stays paused — see openGallery()/closeGallery()). */
function closeLightbox(): void {
  lightboxId = null;
  el("lightbox-overlay")?.classList.remove("open");
}

// --- Gallery (grid) open/close ----------------------------------------------

function openGallery(): void {
  if (isOpen) return;
  isOpen = true;
  pauseForGallery();
  renderGrid();
  el("gallery-overlay")?.classList.add("open");
}

function closeGallery(): void {
  if (!isOpen) return;
  isOpen = false;
  closeLightbox();
  el("gallery-overlay")?.classList.remove("open");
  resumeFromGallery();
}

// --- Wiring ------------------------------------------------------------------

export function startGallery(): void {
  el<HTMLButtonElement>("gallery-open-btn")?.addEventListener("click", openGallery);
  el<HTMLButtonElement>("gallery-close-btn")?.addEventListener("click", closeGallery);
  el<HTMLButtonElement>("lightbox-back-btn")?.addEventListener("click", closeLightbox);
  el<HTMLButtonElement>("lightbox-fav-btn")?.addEventListener("click", () => {
    if (lightboxId) handleToggle(lightboxId);
  });
}
