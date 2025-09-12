# WPlaceViewer Setup Instructions

## Option 1: Release Binary Download
1. Go to the [Releases page](https://github.com/AntonBogun/WPlaceViewer/releases) and download the latest release for your platform.
2. Put the portable executable in a dedicated folder.
3. Run the portable executable.

## Option 2: Run from Source
## Prerequisites

- **Windows** (recommended)
- **Chocolatey** (Windows package manager)
- **nvm-windows** (Node Version Manager for Windows)
- **Node.js** (latest LTS)
- **npm** (comes with Node.js)

## 1. Install Chocolatey

Open PowerShell as **Administrator** and run:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
```

## 2. Install nvm-windows

```powershell
choco install nvm
```

Close and reopen PowerShell.

## 3. Install Latest Node.js

```powershell
nvm install latest
nvm use latest
```

## 4. Clone or Download WPlaceViewer

Download or clone this repository to your desired folder.

## 5. Install Dependencies

Navigate to the project folder:

```powershell
cd <path\to\WPlaceViewer>
npm install
```

## 6. Run the App (Electron)

```powershell
npm start
```
or run with dev tools:
```powershell
npm run dev
```

## Notes

- This project uses **Electron** for desktop functionality and **Leaflet** for map rendering.
- If you see errors about missing dependencies, run `npm install` again.
- For development, you may want to install Electron globally:

```powershell
npm install -g electron
```

## Troubleshooting

- If you have issues with Node.js versions, use `nvm list` and `nvm use <version>` to switch.
- Make sure your PowerShell is running as Administrator for system installs.

---

Enjoy using WPlaceViewer!
