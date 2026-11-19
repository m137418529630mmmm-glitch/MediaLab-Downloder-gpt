//! "Make MediaLab Downloader the main program for torrents" (Options > Torrents):
//! .torrent files and magnet: links of Windows open in MediaLab Downloader, or
//! no more. The same keys the setup writes (its "Torrents" choice), in the
//! user's own part of the registry (no administrator needed).

/// On: Windows opens .torrent files and magnet: links with MediaLab Downloader.
/// Off: only what is MediaLab Downloader's own goes (another program's choice
/// stays as it is).
pub(crate) fn torrents(on: bool) {
    #[cfg(windows)]
    {
        let Ok(exe) = std::env::current_exe() else { return };
        let exe = exe.display().to_string();
        let open = format!("\"{exe}\" \"%1\"");
        let icon = format!("{exe},0");
        if on {
            for (key, name, data) in [
                (r"HKCU\Software\Classes\.torrent\OpenWithProgids", Some("MediaLabDownloader.torrent"), ""),
                (r"HKCU\Software\Classes\.torrent", None, "MediaLabDownloader.torrent"),
                (r"HKCU\Software\Classes\MediaLabDownloader.torrent", None, "Torrent file"),
                (r"HKCU\Software\Classes\MediaLabDownloader.torrent\DefaultIcon", None, icon.as_str()),
                (r"HKCU\Software\Classes\MediaLabDownloader.torrent\shell\open\command", None, open.as_str()),
                (r"HKCU\Software\Classes\magnet", None, "URL:Magnet link"),
                (r"HKCU\Software\Classes\magnet", Some("URL Protocol"), ""),
                (r"HKCU\Software\Classes\magnet\DefaultIcon", None, icon.as_str()),
                (r"HKCU\Software\Classes\magnet\shell\open\command", None, open.as_str()),
            ] {
                crate::winreg::set(key, name, data);
            }
        } else {
            // ours only: a .torrent / magnet that another program took stays
            use crate::winreg;
            if winreg::get(r"HKCU\Software\Classes\.torrent", None).as_deref() == Some("MediaLabDownloader.torrent") {
                winreg::delete_value(r"HKCU\Software\Classes\.torrent", None);
            }
            winreg::delete_value(r"HKCU\Software\Classes\.torrent\OpenWithProgids", Some("MediaLabDownloader.torrent"));
            winreg::delete_key(r"HKCU\Software\Classes\MediaLabDownloader.torrent");
            if winreg::get(r"HKCU\Software\Classes\magnet\shell\open\command", None).is_some_and(|v| v.to_ascii_lowercase().contains("medialabdownloader.exe")) {
                winreg::delete_key(r"HKCU\Software\Classes\magnet");
            }
        }
        // Explorer learns of the change at once
        unsafe {
            use windows_sys::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
            SHChangeNotify(SHCNE_ASSOCCHANGED as i32, SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
        }
    }
    #[cfg(not(windows))]
    let _ = on;
}
