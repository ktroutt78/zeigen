use serde::Serialize;
use std::process::Command;

const FFMPEG_PATH: &str = "/opt/homebrew/bin/ffmpeg";

#[derive(Debug, Serialize, Clone)]
pub struct Device {
    pub index: u32,
    pub name: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct DeviceList {
    pub video: Vec<Device>,
    pub audio: Vec<Device>,
    pub screens: Vec<Device>,
}

pub fn enumerate() -> Result<DeviceList, String> {
    let output = Command::new(FFMPEG_PATH)
        .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output()
        .map_err(|e| format!("failed to run ffmpeg at {FFMPEG_PATH}: {e}"))?;

    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(parse(&stderr))
}

fn parse(stderr: &str) -> DeviceList {
    let mut list = DeviceList::default();
    let mut section: Option<Section> = None;

    for line in stderr.lines() {
        if line.contains("AVFoundation video devices:") {
            section = Some(Section::Video);
            continue;
        }
        if line.contains("AVFoundation audio devices:") {
            section = Some(Section::Audio);
            continue;
        }

        let Some(current) = section else { continue };

        let Some(device) = parse_device_line(line) else { continue };

        match current {
            Section::Video => {
                if device.name.starts_with("Capture screen") {
                    list.screens.push(device);
                } else {
                    list.video.push(device);
                }
            }
            Section::Audio => list.audio.push(device),
        }
    }

    list
}

#[derive(Clone, Copy)]
enum Section {
    Video,
    Audio,
}

fn parse_device_line(line: &str) -> Option<Device> {
    let after_prefix = line.split("indev @ ").nth(1)?;
    let after_addr = after_prefix.split_once(']')?.1.trim_start();
    let bracketed = after_addr.strip_prefix('[')?;
    let (index_str, rest) = bracketed.split_once(']')?;
    let index: u32 = index_str.parse().ok()?;
    Some(Device {
        index,
        name: rest.trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fixture_from_macos_26() {
        let fixture = "[AVFoundation indev @ 0xb04c20140] AVFoundation video devices:\n\
[AVFoundation indev @ 0xb04c20140] [0] MacBook Air Camera\n\
[AVFoundation indev @ 0xb04c20140] [1] KT iPhone Camera\n\
[AVFoundation indev @ 0xb04c20140] [2] MacBook Air Desk View Camera\n\
[AVFoundation indev @ 0xb04c20140] [4] Capture screen 0\n\
[AVFoundation indev @ 0xb04c20140] [5] Capture screen 1\n\
[AVFoundation indev @ 0xb04c20140] AVFoundation audio devices:\n\
[AVFoundation indev @ 0xb04c20140] [0] KT iPhone Microphone\n\
[AVFoundation indev @ 0xb04c20140] [1] MacBook Air Microphone\n";

        let list = parse(fixture);
        assert_eq!(list.video.len(), 3);
        assert_eq!(list.video[0].name, "MacBook Air Camera");
        assert_eq!(list.video[1].name, "KT iPhone Camera");
        assert_eq!(list.screens.len(), 2);
        assert_eq!(list.screens[0].index, 4);
        assert_eq!(list.audio.len(), 2);
        assert_eq!(list.audio[1].name, "MacBook Air Microphone");
    }
}
