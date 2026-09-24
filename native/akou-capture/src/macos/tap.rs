//! A Core Audio process tap (macOS 14.2+, tested from 14.4): a HAL object that exposes the audio
//! rendered by processes, read through a private aggregate device (`aggregate.rs`). The design is
//! hark's `ProcessTap` (MIT), ported: private (invisible to other apps' device lists), unmuted
//! (the user still hears the call), stereo, and either global minus akou's own processes or a
//! mixdown of the chosen apps' processes.

use objc2::AnyThread;
use objc2::rc::Retained;
use objc2_core_audio::{
    AudioHardwareCreateProcessTap, AudioHardwareDestroyProcessTap, AudioObjectID, CATapDescription,
    CATapMuteBehavior,
};
use objc2_foundation::{NSArray, NSNumber, NSString};

/// What the tap captures.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    /// Every process's audio except these process objects.
    GlobalExcluding(Vec<AudioObjectID>),
    /// Only these process objects, mixed down to stereo.
    Processes(Vec<AudioObjectID>),
}

pub struct ProcessTap {
    pub id: AudioObjectID,
    /// The tap's UUID, which the aggregate device's tap list refers to.
    pub uid: String,
    destroyed: bool,
}

impl ProcessTap {
    pub fn create(scope: &Scope, name: &str) -> Result<ProcessTap, String> {
        let objects = |ids: &[AudioObjectID]| -> Retained<NSArray<NSNumber>> {
            let nums: Vec<Retained<NSNumber>> = ids
                .iter()
                .map(|id| NSNumber::numberWithUnsignedInt(*id))
                .collect();
            NSArray::from_retained_slice(&nums)
        };
        // SAFETY: plain Objective-C initialisers and setters on a fresh description object.
        let desc = unsafe {
            let desc = match scope {
                Scope::GlobalExcluding(ids) => {
                    CATapDescription::initStereoGlobalTapButExcludeProcesses(
                        CATapDescription::alloc(),
                        &objects(ids),
                    )
                }
                Scope::Processes(ids) => CATapDescription::initStereoMixdownOfProcesses(
                    CATapDescription::alloc(),
                    &objects(ids),
                ),
            };
            desc.setPrivate(true);
            desc.setMuteBehavior(CATapMuteBehavior::Unmuted);
            desc.setName(&NSString::from_str(name));
            desc
        };
        let mut id: AudioObjectID = 0;
        // SAFETY: valid description and out-pointer.
        let status = unsafe { AudioHardwareCreateProcessTap(Some(&desc), &mut id) };
        if status != 0 || id == 0 {
            return Err(format!("AudioHardwareCreateProcessTap failed ({status})"));
        }
        // SAFETY: the description is alive; UUID is a property read.
        let uid = unsafe { desc.UUID().UUIDString() }.to_string();
        Ok(ProcessTap {
            id,
            uid,
            destroyed: false,
        })
    }

    pub fn destroy(&mut self) {
        if !self.destroyed {
            self.destroyed = true;
            // SAFETY: the tap id came from AudioHardwareCreateProcessTap and is destroyed once.
            unsafe { AudioHardwareDestroyProcessTap(self.id) };
        }
    }
}

impl Drop for ProcessTap {
    fn drop(&mut self) {
        self.destroy();
    }
}
