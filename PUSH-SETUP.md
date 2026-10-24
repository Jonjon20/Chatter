# Push notification (tunog kahit sarado ang app) — Android

## A. Firebase (libre)
1. console.firebase.google.com > Add project (pangalan: Chatter). Puwedeng i-off ang Google Analytics.
2. Sa project: Add app > Android. Package name: `com.chatter.app` (kapareho ng appId sa capacitor.config.json). Register app.
3. I-download ang `google-services.json` at ilagay sa `android/app/google-services.json`
   (lalabas ang folder na `android` pagkatapos ng `npx cap add android`).
4. Project settings (gear) > Service accounts > "Generate new private key" > Generate. May ma-di-download na JSON.
   Ito ang gagamitin sa Supabase (HUWAG ilagay sa app o i-share kahit kanino).

## B. Supabase
1. Edge Functions > Deploy a new function > Via Editor: pangalanan `push`, i-paste ang `push-function.ts`, i-OFF ang "Verify JWT", Deploy.
2. Edge Functions > Secrets, idagdag:
   - `PUSH_SECRET` = kahit anong mahabang random na text
   - `FCM_SERVICE_ACCOUNT` = ang BUONG laman ng JSON na dinownload sa A4 (i-paste lahat, kasama ang { })
3. SQL Editor: buksan ang `upgrade14.sql`, palitan ang LAHAT ng `<PROJECT_REF>` at `<PUSH_SECRET>` (Replace All; kapareho ng secret sa taas), at i-Run. Puwede itong i-run ulit kahit na-run mo na dati.
4. Para sa birthday na notification: Database > Extensions > i-enable ang `pg_cron`, tapos i-run ulit ang huling bahagi ng `upgrade14.sql` (ang may `cron.schedule`).

## C. Android project (sa folder na ito)
```
npm install @capacitor/push-notifications
npx cap sync
```
Pagkatapos ng `npx cap add android` (kung hindi pa nagagawa):
1. Gumawa ng folder `android/app/src/main/res/raw/` at kopyahin doon ang LAHAT ng 8 file sa `android-res-raw/` (new_message, mention, notification, like_reaction, heart_reaction, reply, incoming_call, video_call_incoming).
   (Mahalaga: lowercase ang pangalan. Ito ang tunog ng bawat uri ng notification.)
2. Ilagay ang `google-services.json` (A3) sa `android/app/`.
3. `npx cap open android` > Build APK, i-install sa phone.

## D. Pagsubok
1. Buksan ang app at mag-login. Payagan ang notifications kapag nagtanong.
2. I-close ang app nang buo (swipe away) o patayin ang screen.
3. Magpadala ng mensahe mula sa ibang account. Dapat may notification na may tunog. I-tap ito para mabuksan ang chat.

## Kung hindi gumana
- Supabase > Edge Functions > push > Logs: tingnan ang error (FCM o secret).
- Table `device_tokens`: dapat may row ang user pagkatapos mag-login sa APK.
- Xiaomi/Oppo/Vivo/Realme: Settings > Apps > Chatter > i-allow ang Autostart at i-set ang Battery sa "No restrictions".
- Hindi nagpa-push ang global chat (General) para hindi maingay. Para sa private chat at groups lang.

## Anong notification ang may push (kahit sarado ang app)
- Mensahe sa private chat at group: tunog na `new_message` (kapag may @pangalan mo: `mention`)
- Like sa post mo: `like_reaction`; like sa clip mo: `heart_reaction`
- Comment sa post mo: `reply`
- Friend request, tinanggap na request, na-tag ka, birthday ng kaibigan: `notification`
- Tawag: `incoming_call` (voice) at `video_call_incoming` (video). Isang beses lang tutunog ang ring at lalabas bilang notification; hindi ito full-screen na tawag tulad ng sa Messenger.
## Mahalaga kapag nagpalit ng sound
Kapag may binago ka sa sounds o channels at na-install na ang app dati, i-uninstall muna ang APK bago i-install ulit, dahil hindi na nababago ng Android ang tunog ng channel na nagawa na.
