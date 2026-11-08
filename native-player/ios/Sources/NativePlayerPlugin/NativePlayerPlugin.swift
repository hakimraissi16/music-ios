import AVFoundation
import Capacitor
import Foundation
import MediaPlayer
import UIKit

/// Native audio player for the feasibility test.
/// - AVQueuePlayer: the next track is queued natively, so it starts even while JS is suspended (screen locked).
/// - Lock screen / Control Center: title, artist, artwork, play/pause/next/previous/seek.
/// - Events to JS: time, state, itemChanged, ended, queueEnded, stalled, error, remote.
@objc(NativePlayerPlugin)
public class NativePlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePlayerPlugin"
    public let jsName = "NativePlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise)
    ]

    private struct TrackMeta {
        let id: String
        let title: String
        let artist: String
        let artworkUrl: String?
        let duration: Double
    }

    private let player = AVQueuePlayer()
    private var metas: [ObjectIdentifier: TrackMeta] = [:]
    private var itemObservers: [ObjectIdentifier: NSKeyValueObservation] = [:]
    private var pendingSeek: [ObjectIdentifier: Double] = [:]
    private var currentItemObserver: NSKeyValueObservation?
    private var timeControlObserver: NSKeyValueObservation?
    private var timeObserver: Any?
    private var artworkCache: [String: MPMediaItemArtwork] = [:]
    private var remoteReady = false

    override public func load() {
        player.actionAtItemEnd = .advance
        player.automaticallyWaitsToMinimizeStalling = true

        currentItemObserver = player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.currentItemChanged() }
        }
        timeControlObserver = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.emitState()
                self?.updateNowPlayingProgress()
            }
        }
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main
        ) { [weak self] _ in self?.tick() }

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(itemEnded(_:)), name: .AVPlayerItemDidPlayToEndTime, object: nil)
        nc.addObserver(self, selector: #selector(itemFailedToEnd(_:)), name: .AVPlayerItemFailedToPlayToEndTime, object: nil)
        nc.addObserver(self, selector: #selector(itemStalled(_:)), name: .AVPlayerItemPlaybackStalled, object: nil)
        nc.addObserver(self, selector: #selector(sessionInterrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
    }

    // MARK: - JS API

    /// Replace the queue with this track and start playing.
    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let item = self.makeItem(call) else { return }
            do {
                try self.activateSession()
            } catch {
                call.reject("Audio session error: \(error.localizedDescription)")
                return
            }
            self.setupRemoteCommands()
            self.player.pause()
            self.player.removeAllItems()
            self.player.insert(item, after: nil)
            self.player.play()
            self.updateNowPlaying()
            call.resolve()
        }
    }

    /// Replace whatever is queued after the current item with this one.
    @objc func enqueue(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let item = self.makeItem(call) else { return }
            for queued in self.player.items() where queued !== self.player.currentItem {
                self.player.remove(queued)
            }
            if let current = self.player.currentItem {
                self.player.insert(item, after: current)
            } else {
                self.player.insert(item, after: nil)
            }
            call.resolve(["queued": self.player.items().count])
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            try? self.activateSession()
            self.player.play()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player.pause()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let seconds = call.getDouble("seconds") ?? 0
        DispatchQueue.main.async {
            self.player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600)) { _ in
                self.updateNowPlayingProgress()
                call.resolve()
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player.pause()
            self.player.removeAllItems()
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            call.resolve()
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(self.stateDict())
        }
    }

    // MARK: - Items

    /// Must be called on the main queue (all player state is main-thread only).
    private func makeItem(_ call: CAPPluginCall) -> AVPlayerItem? {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("Missing or invalid url")
            return nil
        }
        var options: [String: Any] = [:]
        if let ua = call.getString("userAgent"), !ua.isEmpty {
            options["AVURLAssetHTTPHeaderFieldsKey"] = ["User-Agent": ua]
        }
        let asset = AVURLAsset(url: url, options: options)
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 30

        let key = ObjectIdentifier(item)
        metas[key] = TrackMeta(
            id: call.getString("id") ?? "",
            title: call.getString("title") ?? "",
            artist: call.getString("artist") ?? "",
            artworkUrl: call.getString("artwork"),
            duration: call.getDouble("duration") ?? 0
        )
        let startAt = call.getDouble("startAt") ?? 0
        if startAt > 0 { pendingSeek[key] = startAt }

        itemObservers[key] = item.observe(\.status, options: [.new]) { [weak self] observed, _ in
            DispatchQueue.main.async { self?.itemStatusChanged(observed) }
        }
        return item
    }

    private func itemStatusChanged(_ item: AVPlayerItem) {
        let key = ObjectIdentifier(item)
        switch item.status {
        case .readyToPlay:
            if let seconds = pendingSeek.removeValue(forKey: key) {
                item.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), completionHandler: nil)
            }
            if item === player.currentItem { updateNowPlaying() }
        case .failed:
            emitError(item, message: item.error?.localizedDescription ?? "item failed", code: (item.error as NSError?)?.code ?? 0)
        default:
            break
        }
    }

    private func forget(_ item: AVPlayerItem) {
        let key = ObjectIdentifier(item)
        itemObservers[key]?.invalidate()
        itemObservers.removeValue(forKey: key)
        metas.removeValue(forKey: key)
        pendingSeek.removeValue(forKey: key)
    }

    private func meta(_ item: AVPlayerItem?) -> TrackMeta? {
        guard let item = item else { return nil }
        return metas[ObjectIdentifier(item)]
    }

    // MARK: - Notifications

    @objc private func itemEnded(_ note: Notification) {
        guard let item = note.object as? AVPlayerItem, let m = meta(item) else { return }
        DispatchQueue.main.async {
            self.notifyListeners("ended", data: ["id": m.id, "t": self.now()])
            self.forget(item)
        }
    }

    @objc private func itemFailedToEnd(_ note: Notification) {
        guard let item = note.object as? AVPlayerItem else { return }
        let err = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? NSError
        DispatchQueue.main.async {
            self.emitError(item, message: err?.localizedDescription ?? "failed to play to end", code: err?.code ?? 0)
        }
    }

    @objc private func itemStalled(_ note: Notification) {
        guard let item = note.object as? AVPlayerItem, let m = meta(item) else { return }
        DispatchQueue.main.async {
            self.notifyListeners("stalled", data: ["id": m.id, "currentTime": self.seconds(item.currentTime()), "t": self.now()])
        }
    }

    @objc private func sessionInterrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .ended,
           let optRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt,
           AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume) {
            DispatchQueue.main.async {
                try? self.activateSession()
                self.player.play()
            }
        }
    }

    private func emitError(_ item: AVPlayerItem, message: String, code: Int) {
        let m = meta(item)
        notifyListeners("error", data: [
            "id": m?.id ?? "",
            "message": message,
            "code": code,
            "currentTime": seconds(item.currentTime()),
            "isCurrent": item === player.currentItem,
            "t": now()
        ])
    }

    private func currentItemChanged() {
        if let m = meta(player.currentItem) {
            notifyListeners("itemChanged", data: ["id": m.id, "t": now()])
            updateNowPlaying()
        } else {
            notifyListeners("queueEnded", data: ["t": now()])
        }
    }

    private func tick() {
        guard let item = player.currentItem, let m = meta(item) else { return }
        notifyListeners("time", data: [
            "id": m.id,
            "currentTime": seconds(item.currentTime()),
            "duration": duration(of: item, fallback: m.duration)
        ])
    }

    private func emitState() {
        notifyListeners("state", data: stateDict())
    }

    private func stateDict() -> [String: Any] {
        let item = player.currentItem
        let status: String
        switch player.timeControlStatus {
        case .playing: status = "playing"
        case .paused: status = "paused"
        case .waitingToPlayAtSpecifiedRate: status = "buffering"
        @unknown default: status = "unknown"
        }
        return [
            "status": status,
            "id": meta(item)?.id ?? "",
            "currentTime": item.map { seconds($0.currentTime()) } ?? 0,
            "duration": item.map { duration(of: $0, fallback: meta($0)?.duration ?? 0) } ?? 0,
            "queued": player.items().count
        ]
    }

    // MARK: - Audio session / lock screen

    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [])
        try session.setActive(true)
    }

    private func setupRemoteCommands() {
        if remoteReady { return }
        remoteReady = true
        UIApplication.shared.beginReceivingRemoteControlEvents()
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            try? self?.activateSession()
            self?.player.play()
            return .success
        }
        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in
            self?.player.pause()
            return .success
        }
        center.togglePlayPauseCommand.isEnabled = true
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.player.timeControlStatus == .paused { self.player.play() } else { self.player.pause() }
            return .success
        }
        center.nextTrackCommand.isEnabled = true
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.player.items().count > 1 { self.player.advanceToNextItem() }
            self.notifyListeners("remote", data: ["command": "next"])
            return .success
        }
        center.previousTrackCommand.isEnabled = true
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.player.seek(to: .zero)
            self.notifyListeners("remote", data: ["command": "previous"])
            return .success
        }
        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self, let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self.player.seek(to: CMTime(seconds: e.positionTime, preferredTimescale: 600)) { _ in
                self.updateNowPlayingProgress()
            }
            return .success
        }
    }

    private func updateNowPlaying() {
        guard let item = player.currentItem, let m = meta(item) else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: m.title.isEmpty ? m.id : m.title,
            MPMediaItemPropertyArtist: m.artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: seconds(item.currentTime()),
            MPNowPlayingInfoPropertyPlaybackRate: Double(player.rate),
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue
        ]
        let dur = duration(of: item, fallback: m.duration)
        if dur > 0 { info[MPMediaItemPropertyPlaybackDuration] = dur }
        if let urlString = m.artworkUrl, let art = artworkCache[urlString] {
            info[MPMediaItemPropertyArtwork] = art
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        if let urlString = m.artworkUrl, artworkCache[urlString] == nil, let url = URL(string: urlString) {
            URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
                guard let data = data, let image = UIImage(data: data) else { return }
                let art = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.artworkCache[urlString] = art
                    if self.meta(self.player.currentItem)?.artworkUrl == urlString { self.updateNowPlaying() }
                }
            }.resume()
        }
    }

    private func updateNowPlayingProgress() {
        guard let item = player.currentItem,
              var info = MPNowPlayingInfoCenter.default().nowPlayingInfo else { return }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = seconds(item.currentTime())
        info[MPNowPlayingInfoPropertyPlaybackRate] = Double(player.rate)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    // MARK: - Helpers

    /// Native timestamp (ms) so JS can tell when an event really happened, even if JS was suspended.
    private func now() -> Double {
        Date().timeIntervalSince1970 * 1000
    }

    private func seconds(_ time: CMTime) -> Double {
        let s = CMTimeGetSeconds(time)
        return s.isFinite ? s : 0
    }

    private func duration(of item: AVPlayerItem, fallback: Double) -> Double {
        let d = CMTimeGetSeconds(item.duration)
        return d.isFinite && d > 0 ? d : fallback
    }
}
