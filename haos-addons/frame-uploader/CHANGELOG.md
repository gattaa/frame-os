# Changelog

All notable changes to the frame-os Uploader add-on.

## 2.1.0 - 2026-07-02

- Gallery + favourites: inline processing now also generates a gallery
  thumbnail (`thumbs/<id>.jpg`, <=300px long edge, JPEG q80) for every photo
  and records it in the manifest's new `thumb` field. New `POST /favourite
  {id, value}` endpoint flips a manifest entry's new `favourite` flag
  (default `false`), protected the same way as `/upload`. A one-shot backfill
  (`processor.py --backfill-thumbnails`, also run automatically on add-on
  startup) generates thumbnails for photos published before this change.

## 2.0.1 - 2026-07-01

- Fix: the upload page's file input had `capture="environment"`, which forces
  mobile browsers straight into the camera and hides the gallery/library
  option. Removed — phones now show the full picker (Photo Library / Take
  Photo / Choose File) so an existing photo can be sent, not just a new one.

## 2.0.0 - 2026-07-01

- Merged `frame-pipeline` into `frame-uploader`: uploads are now processed
  inline (EXIF rotation, downscale, re-encode, strip EXIF, manifest update)
  as part of the same request instead of a separate polling service.

## 1.1.0 - 2026-07-01

- The upload page is now served directly by this add-on over HA Ingress
  (sidebar panel); the standalone Lovelace upload card was dropped.

## 1.0.0 - 2026-07-01

- Initial HAOS add-on wrapper for the uploader/processor.
