FRAGLORD - setup steps

FILES
  app.html              the whole app (the installed app opens this page) (image links are in the IMG and MATCH_IMAGES blocks near the top)
  index.html            the website: only the white download page (edit APK_URL, VERSION, SUPPORT at the bottom)
  img-*.jpg / img-*.webp   all pictures used by the app and the download page
  manifest.json, sw.js  PWA files
  icon-192.png, icon-512.png, icon-maskable-512.png   app icons made from the Fraglord logo
  netlify/functions/payment.js FamGateway payment (server side)
  netlify.toml, package.json   Netlify settings

STEPS
1. Open netlify/functions/payment.js and replace TODO-CREATE-ORDER-PATH with the create-order
   path from https://famgateway.in/docs.php
2. Upload all these files to a GitHub repo. In Netlify choose "Import from Git" and pick the repo.
   (Drag-and-drop does not run payment.js.)
3. Netlify > Site configuration > Environment variables:
   FAM_API_KEY, FIREBASE_SERVICE_ACCOUNT (full JSON), SITE_URL (your site address)
4. Firebase console: turn on Google sign-in, create Firestore, add your site to Authorized domains.
5. Open the site in Chrome, check login, payment and chat, and that "Install app" appears.
6. pwabuilder.com > enter your site address > Package for stores > Android. Before pressing Generate, set:
     Start URL ........ /app.html          (VERY IMPORTANT: the app must open app.html, not the home page)
     Host ............. your site address without https://
     Display mode ..... Standalone
     Icon ............. icon-512.png     Maskable icon: icon-maskable-512.png
     Splash / theme ... #060608 (dark)
   Download the zip.
7. FULL SCREEN FIX: assetlinks.json (from the PWABuilder zip) is already in this folder. Keep it in EVERY deploy.
   After deploying, this address must show the file text in a browser:
     https://freefireearningturnament.netlify.app/.well-known/assetlinks.json
   Then UNINSTALL the old app and install the APK again (Android remembers the failed check).
   If you build a NEW APK with a new key, replace assetlinks.json with the new one from that zip.
8. Keep the signing key from that zip safe. You need it for every update.
9. fraglord.apk (the signed APK from PWABuilder, built for freefireearningturnament.netlify.app) is in this folder, so the Install button downloads it.
   For a new APK, replace fraglord.apk and deploy. Share the website link (the home page is the download page).
   The website shows only the download page. The app itself lives at /app.html and the installed app opens it directly.
   (Until fraglord.apk is uploaded, the Install button on the download page offers the web-app install instead.)
10. For link previews (WhatsApp etc.) the og:image in index.html and app.html can be changed to your full address,
    e.g. https://YOUR-SITE.netlify.app/img-og.jpg


DEPLOY FROM GITHUB (needed for payments, because the payment function runs on Netlify's server)
 A. Put every file of this folder in the ROOT of your GitHub repository (index.html must be at the top, not inside a folder).
 B. Netlify > Add new project > Import from Git > choose the repository. Build command: leave empty. Publish directory: .  (already set in netlify.toml)
 C. Netlify > Project configuration > Environment variables, add:
      FAM_API_KEY              your FamGateway API key
      FIREBASE_SERVICE_ACCOUNT the whole text of the Firebase service-account JSON file (Firebase > Project settings > Service accounts > Generate new key)
      SITE_URL                 https://freefireearningturnament.netlify.app
      D. (Optional) FamGateway dashboard > Webhooks > Add Endpoint is NOT needed: each order carries its own webhook address and the app also checks the payment every few seconds.
 E. Firebase Console > Authentication > Settings > Authorized domains: add freefireearningturnament.netlify.app
 F. Never upload the signing key (.keystore) or the service-account file to GitHub. The .gitignore already blocks them.


NEW: INVITE & EARN, DAILY CHECK-IN, GIFT CARDS (netlify/functions/payment.js must be deployed again)
 - Master admin > Rewards: change every amount (inviter reward, friend bonus, minimum first deposit, 4 rank rewards,
   7 daily rewards, gift card limits and fee, minimum withdrawal) and switch each feature ON or OFF.
 - Invite rewards are paid in play balance, only after the friend's first successful deposit.
 - Gift cards are created and claimed on the server. The claimed money goes to the receiver's play balance.
 - Invite links look like  https://YOUR-SITE/?ref=CODE  and gift links  https://YOUR-SITE/?gift=CODE


ADS AND BANNERS (home page)
  Master admin > Posters: add banner pictures (paste a link or choose a picture from your phone).
  Master admin > Ads: switch ADS ON/OFF and fill up to 3 ads. Each ad can be an Image, a Video (starts muted, the user
  can tap the speaker button for sound) or Ad network code. Choose where ads show (before / after the posters / only ads)
  and press SAVE ADS. They appear for users within a few seconds, no new deploy needed.
  Videos: put the file in the folder  ads/  of this project (for example ads/promo.mp4), upload to GitHub, and write
  /ads/promo.mp4 in the Ads tab. Keep videos short (under 10 s) and small (under 3 MB). Every view uses Netlify
  bandwidth, which counts toward your Netlify credits.
  Ad network code runs inside a sealed box, so it cannot read the app, the login or wallets.

THE ANDROID APK
  fraglord.apk is in the top folder next to index.html, and assetlinks.json matches its signing key (fingerprint 71:2A:53:D5...).
  NEVER upload signing.keystore or signing-key-info.txt to GitHub. They are the key to your app: keep them only on your own device.
