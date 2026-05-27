# StreamVault Setup Builder

## Mapstruktur – exakt så här ska det se ut

```
C:\StreamVault-Build\
│
├── BYGG.bat                          ← Dubbelklicka för att bygga .exe
├── StreamVault.iss                   ← Inno Setup-skriptet
│
├── deps\                             ← Beroenden (du laddar ner dessa)
│   ├── node-v20.14.0-x64.msi         ← Node.js (redan nerladdad)
│   ├── ffmpeg-release-essentials.zip ← FFmpeg (redan nerladdad)
│   └── nssm\
│       └── nssm.exe                  ← Windows Service Manager (se nedan)
│
├── app\                              ← StreamVault-filerna (från ZIP:en)
│   ├── server\
│   │   └── index.js
│   ├── public\
│   │   ├── index.html
│   │   ├── css\
│   │   └── js\
│   ├── setup\
│   │   └── setup.html
│   └── package.json
│
├── assets\                           ← Ikoner (se nedan)
│   ├── icon.ico
│   ├── wizard.bmp
│   └── wizard-small.bmp
│
└── Output\                           ← Skapas automatiskt
    └── StreamVault-Setup.exe         ← Din färdiga installerare!
```

---

## Steg-för-steg

### Steg 1 – Skapa mappstrukturen
Skapa mappen `C:\StreamVault-Build\` och lägg filerna enligt strukturen ovan.

### Steg 2 – Flytta nerladdade filer
Skapa undermappen `deps\` och flytta dit:
- `node-v20.14.0-x64.msi`
- `ffmpeg-release-essentials.zip`

### Steg 3 – Ladda ner NSSM
NSSM är ett litet gratis verktyg som gör att StreamVault kan köras som en Windows-tjänst.

1. Gå till: https://nssm.cc/download
2. Ladda ner senaste versionen
3. Packa upp ZIP-filen
4. Kopiera `nssm-2.24\win64\nssm.exe` till `deps\nssm\nssm.exe`

### Steg 4 – Kopiera StreamVault-filerna
Från ZIP-filen vi byggde tidigare, kopiera dessa mappar till `app\`:
- `server\` → `app\server\`
- `public\` → `app\public\`
- `setup\` → `app\setup\`
- `package.json` → `app\package.json`

### Steg 5 – Skapa ikoner (valfritt men snyggt)
Lägg en `icon.ico` i `assets\`-mappen.
Om du inte har en ikon, skapa assets-mappen tom och ta bort dessa rader ur StreamVault.iss:
```
SetupIconFile=assets\icon.ico
WizardSmallImageFile=assets\wizard-small.bmp
WizardImageFile=assets\wizard.bmp
```
...och raden:
```
Source: "assets\icon.ico"; DestDir: "{#InstallDir}"; Flags: ignoreversion
```

### Steg 6 – Bygg!
Dubbelklicka på `BYGG.bat` – klart!

Din `StreamVault-Setup.exe` skapas i `Output\`-mappen.

---

## Vad installeraren gör automatiskt
När någon dubbelklickar på `StreamVault-Setup.exe`:

1. ✅ Installerar Node.js 20 LTS tyst i bakgrunden
2. ✅ Packar upp FFmpeg med alla codecs
3. ✅ Installerar StreamVault i C:\StreamVault
4. ✅ Kör `npm install` för alla beroenden
5. ✅ Registrerar StreamVault som Windows-tjänst (startar med datorn)
6. ✅ Lägger till brandväggsregel för port 7000
7. ✅ Öppnar StreamVault i webbläsaren automatiskt

Användaren behöver inte göra något manuellt!
