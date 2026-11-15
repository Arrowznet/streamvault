# StreamVault – överlämning till Claude Code (Linux-servern)

Skriven 2026-11-15 som överlämning från webbchatten. **Repot är offentligt.** Därför står här inga maskiner, nycklar, personuppgifter eller säkerhetskänsliga punkter. De finns i `~/streamvault-private.md` på servern (utanför git). Läs den filen också innan du rör drift, och lägg aldrig innehåll från den i repot.

## 1. Projektet
- StreamVault är en egen mediaserver: Node.js/Express, NeDB (append-only), FFmpeg. Privat hobbyprojekt, en enda utvecklare (Christian). Han skriver och vill ha svar på svenska.
- Servern: `app/server/index.js` (mycket stor) plus hjälpmoduler i `app/server/*.js`. Webbklient: `app/public/js/app.js` (en stor fil). Windows-installation: `StreamVault.iss` (Inno Setup). Linux: `deploy/linux/` (README och systemd-exempel).
- Android-appen ligger i ett **separat privat repo** (`streamvault-android`) som Cursor arbetar i på Christians Windows-dator. Rör den inte härifrån, men ändra aldrig API:et bakåtkompatibelt-brytande (se punkt 5).
- Håll projektet helt åtskilt från Christians jobbprojekt. Blanda aldrig in något därifrån.

## 2. Så arbetar vi
**Grenar**
- `main` = Windows-releaserna (senaste release v2.10.1). Ändras bara vid release.
- `linux-port` = allt nyare arbete (Linux-stöd och alla funktioner efter 2.10.1). Här jobbar vi. **Inte sammanslagen med `main` än.** En stor sammanslagning planeras, med ett nytt testbygge av Windows-installationen först.
- `dev` finns men används inte för detta.

**Commit och push**
- Commit-meddelanden på engelska, en rad, beskrivande, till exempel `IPTV: provider (M3U) order for live TV, kept channel ids on refresh, sort switch`. Git-identitet: `Arrowznet <dev@arrowz.net>`.
- Christian pushar normalt själv med GitHub Desktop på Windows (privata kontot Arrowznet, aldrig jobbkontot). På Linux-servern är `gh` utloggat (ogiltig token), så push därifrån kräver `gh auth login` som Arrowznet. Fråga innan du pushar. Pusha aldrig taggar.

**Releaser (Windows)**
- Versionen står i `app/package.json`. Workflowet `.github/workflows/build.yml` ("Build StreamVault Setup", windows-2025, Inno Setup): manuell körning (Actions, Run workflow) ger bara en artifact. En tagg som börjar med `v` startar bygget **och skapar en GitHub Release** med `StreamVault-Setup.exe`. Skapa därför aldrig en `v*`-tagg utan att Christian ber om det.
- Releasenoteringar skrivs för hand (svenska och engelska) och läggs in under Edit på releasen.
- Android-APK:er läggs som bilagor (`streamvault-android-v<version>.apk`) på en **befintlig** release av Cursors skript. Servern letar efter dem i de 10 senaste stabila releaserna och läser versionen ur filnamnet. Skapa aldrig egna releaser eller taggar för appen.
- Repot måste förbli offentligt (appen hämtar APK:n utan inloggning). Inga hemligheter i git, och skriv aldrig om historiken.

**Windows och Linux ihop**
- Det är en kodbas. Linux-specifikt ligger bakom `process.platform === "linux"` eller bakom kodar- och kapacitetsvillkor. **Windows ska bete sig exakt som förut.** Ändra inget som gäller Windows utan att Christian ber om det, och bekräfta uttryckligen i din rapport att inget på Windows ändrats.
- Nya filer i `app/server/` följer med i Windows-installationen automatiskt (`.iss` kopierar `app\server\*`).
- På Linux stöds bara NVIDIA (NVENC). Lämna AMD/QSV/libx264-vägarna som de är.

**Arbetsstil**
- Berätta kort vad du tänker ändra och vänta på OK före större ändringar. Gör inget utöver det som bett om. Visa lista över ändrade filer och rader, och säg uttryckligen vad som **inte** är provat (särskilt sådant som kräver riktig ffmpeg, en webbläsare eller en enhet).
- När Christian ska göra något själv: en sak i taget, mycket tydliga steg, vänta på bekräftelse.
- Provkör nya rena funktioner med `node` utan att starta servern, och kör `node --check` på alla ändrade filer.

## 3. Beslut och önskemål
- HDR till SDR görs på GPU (libplacebo, bt.2390), bara på Linux med `h264_nvenc`. Webbläsare får alltid en omkodad ström, och appen spelar oftast direkt.
- NVENC-kvalitetsprofiler: `balanced` är standard, `high` och `fast` (= gamla flaggorna) finns. Alla får `-forced-idr 1` vid DASH.
- Live-TV visas i leverantörens ordning (inte A–Ö). Filmer och serier är A–Ö. Avdelarkanaler i listan blir rubriker. Användare med IPTV-behörighet kan själva välja vilka länder och språk som visas.
- Serier: säsong läses ur mappnamn (`Season N`) när filnamnet saknar det. Dubbelavsnitt är ett kort med `episode_end`. Säsong 0 visas som "Specialavsnitt" (ingen TMDB för säsong 0).
- Bildundertexter (PGS) konverteras med OCR också på Linux.
- **Christian vill inte:** ändra Windows-beteende oombett, göra repot privat, skriva om git-historiken, radera tittarhistorik eller undertextcache i onödan ("Rensa om" och "Rensa all undertextcache" ska inte användas), ändra port 7000, ha popup-fönster i gränssnittet (osäkra på smart-TV och bilwebbläsare) eller AMD-stöd på Linux.
- Mediafiler på disk döper Christian om själv (monteringen är skrivskyddad). Rör aldrig mediafiler.
- Serier som fått fel säsong eller avsnitt rättas med reparationsverktyget, inte med "Rensa om".

## 4. Kända problem, pågående och planerat
1. **Frysning vid ~70 s (löst, delvis provat).** Orsak: ffmpeg kodar små filer ~50 gånger snabbare än de spelas och blir klar efter ~70 s. Då skriver ffmpeg om manifestet från dynamiskt till statiskt, och dash.js avslutar strömmen vid det den hunnit hämta. Lösning: `-readrate 1 -readrate_initial_burst 20` före `-i` för alla DASH-omkodningar på Linux (`config.dash_readrate`). Provat: Crossroads i 10 minuter utan stopp. **Inte provat:** paus i flera minuter, att spola eller starta mitt i filmen (`-ss` tillsammans med readrate), att stänga fliken (städning), tyngre filmer (1080p x265, 4K HDR) och uppspelning över internet.
2. **Tunn buffert.** Spelaren behandlar strömmen som en direktsändning och ligger bara ~3–7 s före. Fungerar på hemnätet men kan ge stopp över internet. Långsiktig lösning (inte påbörjad): ge spelaren ett fullständigt, VOD-likt manifest för hela filmen från början.
3. **Pausade sessioner:** på Linux dödas en omkodning bara av tidsgränsen `config.dash_idle_minutes` (standard 20, 0 = ingen städning). Om användaren pausar längre får spelaren 404 på segment och fryser. Klientens återhämtning (fånga segmentfel och anropa `/api/dash/:id/seek`) och hjärtslag under paus är **inte byggda**.
4. **Osynkat ljud** har rapporterats (i synk en stund, ett "blink", sedan osynk, och spolning rättar det en stund). Inte mätt efter readrate-rättningen, så det kan vara löst. Känd skillnad: videon börjar 0,125 s efter ljudet (B-bilder i `balanced`).
5. **Windows-uppdateringskontrollen** (`/api/updates/check`) jämför versioner med `!==` och föreslår en nedgradering när den installerade versionen är nyare än senaste release. Ska använda `compareVersions`. Rättas vid sammanslagningen. Android-fälten (`apkVersion`, `hasAndroidUpdate`, `apkDownloadUrl`) påverkas inte.
6. **Felsökningslogg (planerad, ej påbörjad):** per uppspelning, med spelarens stopp och buffertar rapporterade från webbspelaren, ffmpeg-hastighet och tid per segment, GPU/CPU-last och filläsning, samt en säkerhetslogg (nekade anrop, spärrar, konstiga adresser). Allt måste maskera tokens (`?token=`), lösenord och IPTV-adresser med inloggning, ha storleks- och åldersgräns och bara vara synligt för admin.
7. Först när det är provat: **slå ihop `linux-port` med `main`** och släpp ny Windows-version (nytt testbygge först).
8. Undertextcachningen över hela biblioteket ("Cacha om enligt språklistan") är **inte körd**. Den är tung (läser hela filer över nätverket), så kör den en natt när ingen tittar.
9. Android-appen: ändringarna för `episode_end`, "Special" och IPTV-rubriker finns i Cursors kod men är inte provade på en enhet eller TV.

## 5. Fällor i koden

**DASH och ffmpeg**
- All omkodad biblioteksuppspelning går via `/api/dash/*` och dash.js 4.7.4 (CDN). `/api/hls/*` verkar oanvänt för bibliotek (HLS används för IPTV-reservvägen och trailers). Webbspelaren: `window._dashPlayer` och videoelementet `#main-video`, inställningar `bufferTimeAtTopQuality: 12`, `bufferToKeep: 8`, `stallThreshold: 0.5`, `jumpGaps: true`.
- Manifestet (`manifest.mpd`) serveras **som ffmpeg skrev det** (dynamiskt medan ffmpeg kör). Ändra inte detta utan att förstå flippen ovan. `/api/dash/:id/start` väntar bara på första segmentet.
- `-force_key_frames expr:gte(t,n_forced*2)` räcker inte med NVENC: utan `-forced-idr 1` blir segmenten ~10,4 s (250 bilder) och ojämna i stället för 4 s. `nvencArgs.js` lägger på flaggan (bara Linux, `h264_nvenc`, DASH, bara när nyckelbilder tvingas) och provar den vid start.
- Flaggor som beror på ffmpeg-versionen provas asynkront vid start med 8 s tidsgräns och får aldrig hålla upp serverstarten. Avvisas en flagga utelämnas den och en loggrad skrivs.
- Beslutet att döda en omkodning ligger i `dashKillDecision` (`readrateArgs.js`). På Windows gäller den gamla regeln (inget hjärtslag senaste 20 s och äldre än 30 s).
- Uppspelningsbeslutet: `/api/playback/:id` är kapacitetsbaserat när klienten skickar `direct_containers`, `direct_video_codecs` och `direct_audio_codecs` (appen), annars gäller webbläsarreglerna (HEVC omkodas alltid). Servern tittar bara på behållare och kodek, inte på HDR eller upplösning.

**NVENC och HDR**
- Profiler: `fast` = `-preset p1 -rc constqp -qp 23 -zerolatency 1`, `balanced` = `-preset p5 -tune hq -rc vbr -cq 21 -b:v 0 -bf 3 -rc-lookahead 20 -spatial-aq 1 -temporal-aq 1`, `high` = p6, cq 18. Med `vbr` får DASH-kommandot inte lägga `-b:v 4000k` efter flaggorna.
- HDR: filtret `hwupload,libplacebo=...:tonemapping=bt.2390:colorspace=bt709:...,hwdownload` kräver `-init_hw_device vulkan=vk -filter_hw_device vk` och en NVIDIA-Vulkan-drivrutin. Används bara när källans `color_transfer` är `smpte2084` eller `arib-std-b67` (läses med ffprobe, 15 s tidsgräns, sparas i databasen). Kapaciteten kontrolleras vid start. `config.hdr_tonemap = "off"` stänger av.
- Mätt kapacitet (gjord **före** ett byte av processor och minne, så mät om): ~2,6x realtid för en 4K HDR-ström och ~1,2x per ström med tre samtidiga. Räkna med högst ~3 samtidiga 4K-omkodningar tills det är ommätt.

**Skannern och serier** (`episodeParser.js`)
- De fyra ursprungliga filnamnsmönstren körs alltid först. Därefter säsongsledtråd från mappnamnet, numreringsstil per mapp (`compact` som `101 - Titel` eller `absolute` som löpande nummer) och regel 2c (`koq701`, `s711`). Tekniska beteckningar (`1080p`, `x264`, `AAC192`) får aldrig tolkas som avsnitt.
- Skannern ser bara filnamn och mappnamn. Mappar som `Extras` ger ingen ledtråd. Befintliga poster hoppas över vid skanning, så ändrade regler gäller bara nya filer. Befintliga rättas med `POST /api/scan/repair-episodes` (kör **alltid `?dryRun=1` först**; tar en verifierad kopia av `media.db`).
- Dubbelavsnitt: `episode_end` på avsnittsposten. Säsongssidan slår ihop TMDB-uppgifter för båda delarna (`mergeEpisodeMeta`). Säsong 0 hämtar aldrig TMDB (dess specialavsnitt är andra än användarens).
- Film-id byggs av filens fulla sökväg (base64). Byts en monteringspunkt eller ett mappnamn blir alla id nya och historik, favoriter och undertextcache går förlorade.
- `prune` tar bort poster vars filer saknas, men hoppar över ett bibliotek vars rotmapp inte går att nå. Skanna aldrig medan en delning är halv eller tom.
- `fs.watch` upptäcker inte nya filer på nätverksmonteringar (CIFS/NFS). Starta en skanning för hand.

**Undertexter**
- Språklistan (standard sv och en, plus de som admin eller användare lagt till) styr vad som cachas: externa filer, inbäddad text och bildspår. Bildspår hoppas över tills OCR är installerat.
- OCR: PgsToSrt körs med `dotnet` och `DOTNET_ROLL_FORWARD=Major` (.NET 10 på servern), libtesseract5, libleptonica6 och tessdata. DVD-bildspår (VobSub) stöds inte. Bildtexten konverteras första gången någon väljer den (ca 10 minuter för en 4K-remux, webbläsaren ger upp efter ~2 min men servern fortsätter) eller vid "Cacha om".

**IPTV**
- Varje kanal får `order` (platsen i M3U-filen) vid inläsning. Live-listor sorteras efter den (`sortChannels`); filmer och serier A–Ö. Vid uppdatering av spellistan bevaras kanalernas `_id` via adressen (`reuseChannelIds`), så favoriter överlever.
- Avdelarkanaler (falska kanaler som "Sport") pekas ut med `config.iptv_divider_names` (exakt namn, ingen delmatchning). De tas bort ur svar utom med `headings=1` och `sort=list`, och får aldrig läggas i favoritlistor. Appen ber inte om rubriker än.
- Per-användarfilter för länder: `iptv_visible_groups` och `iptv_group_filter` på användaren, via `PATCH /api/users/:id/iptv-groups`, bara för användare med IPTV-behörighet. Filtret tillämpas i servern (`/api/iptv/groups`), så appen får det automatiskt.
- Reservvägen `/api/iptv/live/*` kopierar videon (`-c copy`) till HLS. Den får aldrig ta en godtycklig adress (bara http/https, `-protocol_whitelist`).
- NeDB sparar `iptv_channels.db` append-only och komprimeras var sjätte timme, så ordningen i filen är inte M3U-ordningen. Använd fältet `order`.

**Auth, proxy och loggar**
- JWT. `config.trusted_proxies` (standard `["loopback"]`) styr vilken proxy servern tror på för besökarens IP. Lägg aldrig till `*`, `0.0.0.0/0` eller för breda nät (koden avvisar det).
- Hastighetsgränser per IP (`/api/auth`, `/api`) och en inloggningsspärr via `attempts.db`.
- Systemloggen (Inställningar, Systemlogg) ligger i `<datamapp>/logs/` med daglig rotation. HTTP-rader skrivs **bara** där, inte i journald. `[PLAYBACK]` och `[DASH]` finns i båda.
- NeDB-filer är append-only och gamla versioner av en post ligger kvar tills komprimering. När du läser dem rakt av: sista raden per `_id` gäller, och `$$deleted` tar bort posten.

## 6. Testa innan du pushar
1. `node --check` på varje ändrad fil. Rena funktioner (`episodeParser.js`, `iptvOrder.js`, `nvencArgs.js`, `readrateArgs.js`, `trustProxy.js`) provkörs med `node` utan servern, med uttryckliga fall inklusive Windows (ska ge oförändrat resultat).
2. Deploy på Linux-servern: `cd ~/streamvault && git pull && sudo systemctl restart streamvault`, vänta ~35 s (starttesterna), titta sedan i `journalctl -u streamvault` efter `StreamVault v...`, `[NVENC]`, `[DASH] readrate` och `error`.
3. Uppspelning provas i Chrome med F12-konsolen: läs `window._dashPlayer.isDynamic()`, `getBufferLength("video")`, videoelementets `buffered`, och räkna `waiting`-händelser. Friskt: `dyn` är `true` hela vägen, ingen `ended` mitt i filmen och inga `waiting`.
4. Serverns omkodning mäts manuellt vid behov: bitlängder ur `manifest.mpd`, `[DASH] Done: ... ffmpeg höll på X s`, GPU med `nvidia-smi dmon`.
5. Reparationsverktyget: `dryRun=1` först och läs exemplen. Ta en säkerhetskopia av datamappen före riskfyllda ändringar (exkludera `dash`, `hls` och `iptv_live`).
6. Provkör aldrig något mot en halv eller tom delning, och kör inte "Rensa om" eller "Rensa all undertextcache" på den riktiga servern.

## 7. Inställningar i `config.json` (utöver vanliga)
`transcode_quality` (`balanced` | `high` | `fast`), `hdr_tonemap` (`auto` | `off`), `dash_readrate` (standard 1, 0 = av, över 1 ger frysning vid ungefär filmlängd/värde), `dash_idle_minutes` (standard 20, 0 = ingen städning, bara Linux), `trusted_proxies`, `iptv_divider_names`, `iptv_m3u_url`. Nycklar för TMDB, OpenSubtitles och OMDb ligger i inställningarna (`config.json`); `keys.js` (ignoreras av git) läses bara när ett fält är tomt. Skriv aldrig ut sådana värden.

## 8. Idéer i kö (inte påbörjade)
- IPTV: ett valbart "Avancerat" läge (stor liveförhandsvisning, kompakt kanallista med logga, pågående program och framsteg, som TiviMate) bredvid dagens enkla kortvy. Valet ska komma ihåg, eftersom liveförhandsvisning inte fungerar på alla enheter.
- Per-användarens språk för undertextcachning och TMDB-metadata vid skanning (bara standardspråket respekteras idag).
- Genrefiltret på samlingssidan kan behöva en "Hämta genrer"-ifyllning.
- Ljudböcker: väntar tills Jellyfin 12.0 är stabil och Christian har filer att prova med. Eget biblioteksslag (M4B, kapitel), eftersom återupptagning inte fungerar för musikbibliotek.
