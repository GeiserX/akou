//! The private aggregate device that hosts a process tap, and its IO callback.
//!
//! A tap is read through an aggregate device whose tap list holds it: private (only this process
//! sees it, and it disappears with the process, so a killed helper leaks nothing), `tap_auto_start`
//! on (TRAPS "Tap does not auto-start"), drift compensation on. Unlike hark, the microphone is not
//! a sub-device: it is its own stream, so a silent or dead tap can never hold the mic back
//! (DESIGN 2.1, TRAPS T0.16).
//!
//! The IO callback converts each buffer to mono float at the edge (`convert`), stamps it with
//! the buffer's host time and hands it to the engine without blocking; a full queue drops the
//! buffer and counts it.

use std::ffi::{CStr, c_void};
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;

use objc2_core_audio::{
    AudioDeviceCreateIOProcID, AudioDeviceDestroyIOProcID, AudioDeviceIOProcID, AudioDeviceStart,
    AudioDeviceStop, AudioHardwareCreateAggregateDevice, AudioHardwareDestroyAggregateDevice,
    AudioObjectID, kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
    kAudioAggregateDeviceUIDKey, kAudioDevicePropertyNominalSampleRate,
    kAudioDevicePropertyScopeInput, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeGlobal,
    kAudioStreamPropertyVirtualFormat, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
};
use objc2_core_audio_types::{
    AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp, AudioTimeStampFlags,
    kAudioFormatFlagIsAlignedHigh, kAudioFormatFlagIsBigEndian, kAudioFormatFlagIsFloat,
    kAudioFormatFlagIsNonInterleaved, kAudioFormatLinearPCM,
};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFString, CFType};

use super::props;
use super::tap::ProcessTap;
use crate::clock;
use crate::convert::{Format, SampleKind, to_mono};
use crate::protocol::Ch;
use crate::source::{Chunk, Event};

/// Maps a stream's format to the converter's, or says why it cannot be read.
pub fn format_of(asbd: &AudioStreamBasicDescription) -> Result<Format, String> {
    if asbd.mFormatID != kAudioFormatLinearPCM {
        return Err(format!(
            "stream format {:#x} is not linear PCM",
            asbd.mFormatID
        ));
    }
    let flags = asbd.mFormatFlags;
    if flags & kAudioFormatFlagIsBigEndian != 0 {
        return Err("big-endian stream".into());
    }
    let channels = asbd.mChannelsPerFrame.max(1) as usize;
    let interleaved = flags & kAudioFormatFlagIsNonInterleaved == 0;
    let bytes = if interleaved {
        asbd.mBytesPerFrame as usize / channels
    } else {
        asbd.mBytesPerFrame as usize
    };
    let bits = asbd.mBitsPerChannel;
    let kind = if flags & kAudioFormatFlagIsFloat != 0 {
        match bits {
            32 => SampleKind::F32,
            64 => SampleKind::F64,
            _ => return Err(format!("{bits}-bit float stream")),
        }
    } else {
        match (bits, bytes) {
            (16, 2) => SampleKind::I16,
            (24, 3) => SampleKind::I24Packed,
            (24, 4) if flags & kAudioFormatFlagIsAlignedHigh != 0 => SampleKind::I32,
            (24, 4) => SampleKind::I24InI32,
            (32, 4) => SampleKind::I32,
            _ => return Err(format!("{bits}-bit integer stream in {bytes} bytes")),
        }
    };
    if kind.bytes() != bytes {
        return Err(format!("{bits}-bit stream in {bytes} bytes"));
    }
    Ok(Format {
        kind,
        channels,
        interleaved,
    })
}

/// Where a callback's audio goes.
pub enum Sink {
    /// The live call stream.
    Stream {
        tx: SyncSender<Event>,
        dropped: Arc<AtomicU64>,
    },
    /// A probe: set when any sample on any channel is non-zero.
    Probe(Arc<AtomicBool>),
}

struct IoCtx {
    format: Format,
    rate: u32,
    sink: Sink,
}

/// The IO callback. Runs on Core Audio's real-time thread: it never blocks, and it allocates
/// only the chunk it hands over.
unsafe extern "C-unwind" fn io_proc(
    _device: AudioObjectID,
    _now: NonNull<AudioTimeStamp>,
    input: NonNull<AudioBufferList>,
    input_time: NonNull<AudioTimeStamp>,
    _output: NonNull<AudioBufferList>,
    _output_time: NonNull<AudioTimeStamp>,
    client: *mut c_void,
) -> i32 {
    if client.is_null() {
        return 0;
    }
    // SAFETY: `client` is the `IoCtx` registered with this IOProc, alive until the IOProc is
    // destroyed; Core Audio passes valid buffer lists and timestamps.
    let (ctx, abl, time) = unsafe {
        (
            &*(client as *const IoCtx),
            input.as_ptr(),
            input_time.as_ref(),
        )
    };
    // SAFETY: an AudioBufferList holds `mNumberBuffers` buffers inline.
    let bufs = unsafe {
        std::slice::from_raw_parts((*abl).mBuffers.as_ptr(), (*abl).mNumberBuffers as usize)
    };
    if bufs.is_empty() {
        return 0;
    }
    // The tap stream is the last input stream; non-interleaved, it spans the last `channels`
    // buffers. A tap-only aggregate has just that one stream.
    let take = if ctx.format.interleaved {
        1
    } else {
        ctx.format.channels.min(bufs.len())
    };
    let mut slices: [&[u8]; 8] = [&[]; 8];
    let used = &bufs[bufs.len() - take..];
    for (i, b) in used.iter().take(8).enumerate() {
        if !b.mData.is_null() {
            // SAFETY: Core Audio's buffer, valid for the duration of the callback.
            slices[i] = unsafe {
                std::slice::from_raw_parts(b.mData as *const u8, b.mDataByteSize as usize)
            };
        }
    }
    let slices = &slices[..take.min(8)];
    let awake_ns = if time.mFlags.contains(AudioTimeStampFlags::HostTimeValid) {
        clock::host_ticks_to_ns(time.mHostTime)
    } else {
        clock::now().awake_ns
    };
    match &ctx.sink {
        Sink::Stream { tx, dropped } => {
            let mut samples = Vec::new();
            let heard = to_mono(ctx.format, slices, &mut samples);
            if samples.is_empty() {
                return 0;
            }
            let chunk = Chunk {
                ch: Ch::Call,
                awake_ns,
                rate: ctx.rate,
                samples,
                heard,
            };
            if tx.try_send(Event::Chunk(chunk)).is_err() {
                dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        Sink::Probe(flag) => {
            let mut samples = Vec::new();
            if to_mono(ctx.format, slices, &mut samples) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
    0
}

fn cf_key(k: &CStr) -> objc2_core_foundation::CFRetained<CFString> {
    CFString::from_str(k.to_str().unwrap_or_default())
}

/// A running tap-only aggregate device with its IOProc.
pub struct Aggregate {
    pub id: AudioObjectID,
    pub rate: u32,
    pub format: Format,
    proc_id: AudioDeviceIOProcID,
    ctx: *mut IoCtx,
    started: bool,
}

// SAFETY: the raw context pointer is only dereferenced by the IOProc, and freed after the IOProc
// is destroyed; the struct itself moves between threads only as a whole.
unsafe impl Send for Aggregate {}

impl Aggregate {
    /// Creates the aggregate around `tap`, reads its stream format and starts the IOProc.
    pub fn open(tap: &ProcessTap, name: &str, uid: &str, sink: Sink) -> Result<Aggregate, String> {
        let sub = CFDictionary::<CFString, CFType>::from_slices(
            &[
                &*cf_key(kAudioSubTapUIDKey),
                &*cf_key(kAudioSubTapDriftCompensationKey),
            ],
            &[&*CFString::from_str(&tap.uid), CFBoolean::new(true)],
        );
        let taps = CFArray::<CFType>::from_objects(&[&*sub]);
        let yes = CFBoolean::new(true);
        let desc = CFDictionary::<CFString, CFType>::from_slices(
            &[
                &*cf_key(kAudioAggregateDeviceNameKey),
                &*cf_key(kAudioAggregateDeviceUIDKey),
                &*cf_key(kAudioAggregateDeviceIsPrivateKey),
                &*cf_key(kAudioAggregateDeviceTapAutoStartKey),
                &*cf_key(kAudioAggregateDeviceTapListKey),
            ],
            &[
                &*CFString::from_str(name),
                &*CFString::from_str(uid),
                yes,
                yes,
                &*taps,
            ],
        );
        let mut id: AudioObjectID = 0;
        // SAFETY: a valid description dictionary and out-pointer.
        let status =
            unsafe { AudioHardwareCreateAggregateDevice(desc.as_opaque(), NonNull::from(&mut id)) };
        if status != 0 || id == 0 {
            return Err(format!(
                "AudioHardwareCreateAggregateDevice failed ({status})"
            ));
        }
        let destroy = |id| {
            // SAFETY: an aggregate this function created.
            unsafe { AudioHardwareDestroyAggregateDevice(id) };
        };
        let rate = props::get::<f64>(
            id,
            kAudioDevicePropertyNominalSampleRate,
            kAudioObjectPropertyScopeGlobal,
        )
        .ok()
        .filter(|r| *r > 0.0)
        .map(|r| r.round() as u32);
        let streams = props::get_ids(
            id,
            kAudioDevicePropertyStreams,
            kAudioDevicePropertyScopeInput,
        )
        .unwrap_or_default();
        let asbd = streams.last().and_then(|s| {
            props::get::<AudioStreamBasicDescription>(
                *s,
                kAudioStreamPropertyVirtualFormat,
                kAudioObjectPropertyScopeGlobal,
            )
            .ok()
        });
        let (Some(rate), Some(asbd)) = (rate, asbd) else {
            destroy(id);
            return Err("the aggregate device reports no input stream".into());
        };
        let format = match format_of(&asbd) {
            Ok(f) => f,
            Err(e) => {
                destroy(id);
                return Err(e);
            }
        };
        let ctx = Box::into_raw(Box::new(IoCtx { format, rate, sink }));
        let mut proc_id: AudioDeviceIOProcID = None;
        // SAFETY: the callback and its context outlive the IOProc (freed in `close`).
        let status = unsafe {
            AudioDeviceCreateIOProcID(
                id,
                Some(io_proc),
                ctx as *mut c_void,
                NonNull::from(&mut proc_id),
            )
        };
        let mut agg = Aggregate {
            id,
            rate,
            format,
            proc_id,
            ctx,
            started: false,
        };
        if status != 0 || agg.proc_id.is_none() {
            agg.close();
            return Err(format!("AudioDeviceCreateIOProcID failed ({status})"));
        }
        // SAFETY: a device and IOProc created above.
        let status = unsafe { AudioDeviceStart(id, agg.proc_id) };
        if status != 0 {
            agg.close();
            return Err(format!("AudioDeviceStart failed ({status})"));
        }
        agg.started = true;
        Ok(agg)
    }

    /// Stops the IOProc and destroys the device. Safe to call twice.
    pub fn close(&mut self) {
        // SAFETY: each object is released once, in the reverse order of creation, and the
        // context is freed only after the IOProc that uses it is gone.
        unsafe {
            if self.started {
                AudioDeviceStop(self.id, self.proc_id);
                self.started = false;
            }
            if self.proc_id.is_some() {
                AudioDeviceDestroyIOProcID(self.id, self.proc_id);
                self.proc_id = None;
            }
            if self.id != 0 {
                AudioHardwareDestroyAggregateDevice(self.id);
                self.id = 0;
            }
            if !self.ctx.is_null() {
                drop(Box::from_raw(self.ctx));
                self.ctx = std::ptr::null_mut();
            }
        }
    }
}

impl Drop for Aggregate {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asbd(
        flags: u32,
        bits: u32,
        bytes_per_frame: u32,
        channels: u32,
    ) -> AudioStreamBasicDescription {
        AudioStreamBasicDescription {
            mSampleRate: 48_000.0,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: flags,
            mBytesPerPacket: bytes_per_frame,
            mFramesPerPacket: 1,
            mBytesPerFrame: bytes_per_frame,
            mChannelsPerFrame: channels,
            mBitsPerChannel: bits,
            mReserved: 0,
        }
    }

    /// [T0.28] every format a tap stream can come in maps to the converter.
    #[test]
    fn t0_28_stream_formats_map_to_the_converter() {
        let f = format_of(&asbd(kAudioFormatFlagIsFloat, 32, 8, 2)).unwrap();
        assert_eq!(
            (f.kind, f.channels, f.interleaved),
            (SampleKind::F32, 2, true)
        );
        let f = format_of(&asbd(
            kAudioFormatFlagIsFloat | kAudioFormatFlagIsNonInterleaved,
            32,
            4,
            2,
        ))
        .unwrap();
        assert_eq!((f.kind, f.interleaved), (SampleKind::F32, false));
        assert_eq!(format_of(&asbd(0, 16, 4, 2)).unwrap().kind, SampleKind::I16);
        assert_eq!(
            format_of(&asbd(0, 24, 6, 2)).unwrap().kind,
            SampleKind::I24Packed
        );
        assert_eq!(
            format_of(&asbd(kAudioFormatFlagIsAlignedHigh, 24, 8, 2))
                .unwrap()
                .kind,
            SampleKind::I32
        );
        assert_eq!(
            format_of(&asbd(0, 24, 8, 2)).unwrap().kind,
            SampleKind::I24InI32
        );
        assert_eq!(format_of(&asbd(0, 32, 8, 2)).unwrap().kind, SampleKind::I32);
        assert!(format_of(&asbd(kAudioFormatFlagIsBigEndian, 16, 4, 2)).is_err());
        let mut aac = asbd(0, 16, 4, 2);
        aac.mFormatID = 0x61616320;
        assert!(format_of(&aac).is_err());
    }
}
