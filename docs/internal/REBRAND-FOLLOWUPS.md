# Rebrand follow-ups

_Moved out of the README on 2026-10-07. This is the operator checklist for the SoundCloud Toolkit → Track Toolkit rename; the public story is in the README's About section._

The code, copy, metadata and in-app announcements ship as Track Toolkit. What
is left is outside the repository and has to be done by hand, in this order:

1. ~~Register the new domain and point it at the app.~~ Done (2026-09-20):
   `tracktoolkit.com` and `www` serve the app from Azure App Service; the
   old `soundcloudtoolkit.com` hosts 301/308 to it (`docs/internal/MIGRATION.md`).
2. SoundCloud OAuth app registration: ~~redirect URI~~ done
   (`https://tracktoolkit.com/api/auth/callback`, 2026-09-20). Still to do:
   rename the app to "Track Toolkit" and upload
   `frontend-UI/public/brand/icon-512.png` as its icon so the authorize
   screen shows the new mark.
3. ~~Redraw the logo and icon artwork.~~ Done (2026-09-20): the new mark and
   wordmark live under `frontend-UI/public/brand/`, generated from
   `docs/brand/tools/mark-spec.cjs`. The legacy `SC Toolkit Icon*` and
   `sc toolkit transparent*` files now carry the same artwork and exist only
   because the Chrome extension points at them.
4. ~~Re-point `og-image.png`, the sitemap, `robots.txt` and the canonical URLs
   at the new domain, re-verify in Search Console~~ done (2026-09-20:
   `tracktoolkit.com` verified as a Domain property, sitemap submitted).
   Still to do: submit the change of address from the `soundcloudtoolkit.com`
   property. Also upload `og-image.png` as the GitHub repository's social
   preview.
5. Chrome extension (separate project): copy
   `docs/brand/extension/icon-{16,32,48,128}.png` into its icons folder,
   point `manifest.icons` and `action.default_icon` at them, rename the
   listing to Track Toolkit and re-publish. Only after the published
   extension no longer requests the legacy filenames may the two legacy
   image files be removed from `frontend-UI/public/`. The DigitalOcean app
   is not renamed; it is decommissioned after the Azure soak.

