/*
 * frame-os upload card — a dependency-free Home Assistant Lovelace card.
 *
 * A file input + caption + submit button that POSTs a multipart upload to the
 * frame-os uploader sidecar. Attribution comes from `hass.user.name`, so the
 * frame can show who sent each photo without any HA backend changes.
 *
 * No build step, no imports (no LitElement) — plain custom element so it loads
 * on any HA companion app / browser.
 *
 * Lovelace config:
 *   type: custom:frame-os-upload-card
 *   sidecar_url: https://ha.example.com/frame-upload   # required
 *   title: Add a photo                                  # optional
 *   token: ""                                           # optional, X-Upload-Token
 */

class FrameOsUploadCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.sidecar_url) {
      throw new Error("frame-os-upload-card: 'sidecar_url' is required");
    }
    this._config = config;
    this._built = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    // Keep the attribution name fresh.
    const name = hass && hass.user && hass.user.name ? hass.user.name : "family";
    this._uploader = name;
    if (this._who) this._who.textContent = "Sending as " + name;
  }

  getCardSize() {
    return 3;
  }

  _build() {
    this._built = true;
    const cfg = this._config;
    const title = cfg.title || "Add a photo";

    const root = document.createElement("ha-card");
    root.header = title;

    const wrap = document.createElement("div");
    wrap.style.padding = "0 16px 16px";
    wrap.innerHTML = [
      '<div class="who" style="font-size:0.85em;color:var(--secondary-text-color);margin-bottom:8px;"></div>',
      '<label class="file-btn" style="display:block;margin-bottom:10px;">',
      '  <input class="file" type="file" accept="image/*" style="width:100%;" />',
      "</label>",
      '<img class="preview" alt="" style="display:none;max-width:100%;max-height:180px;border-radius:8px;margin-bottom:10px;" />',
      '<input class="caption" type="text" placeholder="Caption (optional)" maxlength="280"',
      '  style="width:100%;box-sizing:border-box;padding:10px;margin-bottom:12px;border-radius:8px;',
      '  border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color);" />',
      '<button class="submit" style="width:100%;padding:12px;border:none;border-radius:8px;cursor:pointer;',
      '  font-size:1em;background:var(--primary-color);color:var(--text-primary-color,#fff);">Send to frame</button>',
      '<div class="bar" style="height:6px;border-radius:3px;background:var(--divider-color);margin-top:12px;overflow:hidden;display:none;">',
      '  <div class="bar-fill" style="height:100%;width:0%;background:var(--primary-color);transition:width 0.15s;"></div>',
      "</div>",
      '<div class="status" role="status" aria-live="polite" style="margin-top:10px;font-size:0.9em;min-height:1.2em;"></div>',
    ].join("");

    root.appendChild(wrap);
    this.innerHTML = "";
    this.appendChild(root);

    this._file = wrap.querySelector(".file");
    this._preview = wrap.querySelector(".preview");
    this._caption = wrap.querySelector(".caption");
    this._submit = wrap.querySelector(".submit");
    this._bar = wrap.querySelector(".bar");
    this._barFill = wrap.querySelector(".bar-fill");
    this._status = wrap.querySelector(".status");
    this._who = wrap.querySelector(".who");

    this._file.addEventListener("change", () => this._onFile());
    this._submit.addEventListener("click", () => this._onSubmit());
  }

  _onFile() {
    const f = this._file.files && this._file.files[0];
    this._setStatus("");
    if (!f) {
      this._preview.style.display = "none";
      return;
    }
    // Local preview (no upload yet).
    const url = URL.createObjectURL(f);
    this._preview.src = url;
    this._preview.style.display = "block";
    this._preview.onload = () => URL.revokeObjectURL(url);
  }

  _setStatus(msg, color) {
    this._status.textContent = msg || "";
    this._status.style.color = color || "var(--secondary-text-color)";
  }

  _setBusy(busy) {
    this._submit.disabled = busy;
    this._submit.style.opacity = busy ? "0.6" : "1";
    this._bar.style.display = busy ? "block" : "none";
    if (!busy) this._barFill.style.width = "0%";
  }

  _onSubmit() {
    const f = this._file.files && this._file.files[0];
    if (!f) {
      this._setStatus("Pick a photo first.", "var(--error-color, #c00)");
      return;
    }

    const form = new FormData();
    form.append("file", f, f.name);
    form.append("uploader", this._uploader || "family");
    form.append("caption", this._caption.value || "");

    const xhr = new XMLHttpRequest();
    xhr.open("POST", this._config.sidecar_url, true);
    if (this._config.token) xhr.setRequestHeader("X-Upload-Token", this._config.token);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        this._barFill.style.width = pct + "%";
      }
    };
    xhr.onload = () => {
      this._setBusy(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        let id = "";
        try { id = (JSON.parse(xhr.responseText) || {}).id || ""; } catch (e) { /* ignore */ }
        this._setStatus("Sent! It will appear on the frame shortly." + (id ? " (#" + id + ")" : ""),
          "var(--success-color, #2e7d32)");
        this._file.value = "";
        this._caption.value = "";
        this._preview.style.display = "none";
      } else {
        let detail = "";
        try { detail = (JSON.parse(xhr.responseText) || {}).detail || ""; } catch (e) { /* ignore */ }
        this._setStatus("Upload failed (" + xhr.status + ")" + (detail ? ": " + detail : ""),
          "var(--error-color, #c00)");
      }
    };
    xhr.onerror = () => {
      this._setBusy(false);
      this._setStatus("Network error — could not reach the frame uploader.",
        "var(--error-color, #c00)");
    };

    this._setBusy(true);
    this._setStatus("Uploading…");
    xhr.send(form);
  }
}

if (!customElements.get("frame-os-upload-card")) {
  customElements.define("frame-os-upload-card", FrameOsUploadCard);
}

// Make it discoverable in the dashboard "Add card" picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: "frame-os-upload-card",
  name: "frame-os Upload Card",
  description: "Send a photo (with caption + attribution) to the frame-os display.",
});
