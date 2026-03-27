// noinspection JSUnresolvedReference

import { WebSocket } from "partysocket";
import "../utils/logger.js"

const log = logger('KodiComponent.js');

function getKodiProtocols() {
    // Read SSL setting from centralized config
    const kodiSSL = Alpine.store('config').kodiSSL;

    // Default to HTTP/WS even if web app itself is HTTPS (typical mixed content scenario as Kodi doesn't by default support SSL)
    return {
        http: kodiSSL ? 'https://' : 'http://',
        ws: kodiSSL ? 'wss://' : 'ws://'
    };
}

function sendKodiMessageOverWebSocket(rws, method, params) {
    let msg = {
        "jsonrpc": "2.0",
        "method": method,
        "id": method,
    };
    if (params) {
        msg.params = params;
    }
    //log.info("About to send message:", msg)
    rws.send(JSON.stringify(msg));
}

window.kodi = () => {

    // globals to store our Kodi websocket
    let rws = null;

    // WebSocket workaround variables
    let pingInterval = null;

    // WebSocket workaround: Health check implementation
    const startHealthCheck = () => {
        if (pingInterval) {
            clearInterval(pingInterval);
        }

        pingInterval = setInterval(() => {
            if (rws && rws.readyState === 1) { // OPEN
                try {
                    const pingMessage = {
                        "jsonrpc": "2.0",
                        "method": "JSONRPC.Ping",
                        "id": "health-check-ping"
                    };
                    rws.send(JSON.stringify(pingMessage));
                } catch (error) {
                    log.warn('Health check ping failed:', error);
                    if (rws) {
                        rws.close(1011, 'Closing WebSocket to Kodi as health check failed');
                    }
                }
            }
        }, 30000);  // Ping every 30 seconds
    };

    return {
        artwork: null,
        artworks: [],
        title: '',
        season: '',
        episode: '',
        finishTime: '',
        timeRemainingAsTime: '',
        premiered: '',

        _updateTimeRemainingInterval: null,
        _monitoringKodiPlayback: null,
        _offlineHandlerRegistered: false,
        _initDelay: null,
        _connectTimeout: null,
        _currentMediaType: null,

        getArtwork(key) {
            const foundArtwork = this.artworks.find((artwork) => artwork.key === key);
            return foundArtwork?.url || null;
        },

        getFormattedSeasonAndEpisode() {
            const seasonNumber = Number.parseInt(this.season, 10);
            const episodeNumber = Number.parseInt(this.episode, 10);

            if (!Number.isFinite(seasonNumber) || !Number.isFinite(episodeNumber) || seasonNumber <= 0 || episodeNumber <= 0) {
                return '';
            }

            return `${seasonNumber}x${episodeNumber}`;
        },

        getFormattedSeason() {
            const seasonNumber = Number.parseInt(this.season, 10);
            return Number.isFinite(seasonNumber) && seasonNumber > 0 ? String(seasonNumber) : '';
        },

        getFormattedEpisode() {
            const episodeNumber = Number.parseInt(this.episode, 10);
            return Number.isFinite(episodeNumber) && episodeNumber > 0 ? String(episodeNumber) : '';
        },

        getFormattedTemperature() {
            const temperature = Number.parseFloat(this.temperature);
            return Number.isFinite(temperature) ? temperature.toFixed(1) : '';
        },

        getFormattedFeelsLike() {
            const feelsLike = Number.parseFloat(this.feelsLike);
            return Number.isFinite(feelsLike) ? feelsLike.toFixed(1) : '';
        },

        getFormattedPremiered() {
            if (!this.premiered) {
                return '';
            }

            const parts = String(this.premiered).slice(0, 10).split('-');
            if (parts.length !== 3) {
                return '';
            }

            const [year] = parts;
            return year;
        },

        createEnhancedKodiWebSocket() {

            const protocols = getKodiProtocols();
            const kodiWebsocketUrl = `${protocols.ws}${Alpine.store('config').kodiJsonUrl}/jsonrpc`;

            const normaliseKodiArtworkUrl = (artworkFromKodi) => {
                if (!artworkFromKodi) {
                    return null;
                }

                let normalisedArtwork = String(artworkFromKodi).replace(/\/$/, '');

                if (normalisedArtwork.startsWith("http")) {
                    return normalisedArtwork;
                }

                return `${protocols.http}${Alpine.store('config').kodiWebUrl}/image/${encodeURIComponent(normalisedArtwork)}`;
            };

            const options = {
                connectionTimeout: 2000,        // Increased slightly for network stability
                minReconnectionDelay: 3000,     // Start with 3 seconds instead of 500ms
                maxReconnectionDelay: 30000,    // 30 seconds to handle reboots gracefully
                reconnectionDelayGrowFactor: 1.5, // Slightly more aggressive backoff
                maxEnqueuedMessages: 0,
                debug: false,
            };

            log.info(`*** Opening new websocket connection to Kodi: ${kodiWebsocketUrl}`);

            // Workaround 1: Reset existing connection reference
            if (rws) {
                log.info('Resetting existing WebSocket reference');
                try {
                    if (rws.readyState < 2) rws.close(1000, 'Re-init'); // normal closure
                } catch (_) { /* ignore */ }
                rws = null;
                if (pingInterval) {
                    clearInterval(pingInterval);
                    pingInterval = null;
                }
                if (this._updateTimeRemainingInterval) {
                    clearInterval(this._updateTimeRemainingInterval);
                    this._updateTimeRemainingInterval = null;
                }
            }

            this._connectTimeout = setTimeout(() => {
                try {
                    rws = new WebSocket(kodiWebsocketUrl, undefined, options);

                    rws.addEventListener('open', () => {
                        log.info("Websocket [open]: Connection opened to Kodi")
                        // (DON'T set Kodi available here - wait for actual playback)
                        startHealthCheck();
                        // Check if Kodi is already playing, as soon as we connect...
                        sendKodiMessageOverWebSocket(rws, 'Player.GetActivePlayers', {});
                    });

                    rws.addEventListener('error', (event) => {
                        if (options.debug) log.info('WebSocket [error]:', event);
                        this._handleDisconnectCleanup();
                    });

                    // Register offline handler once
                    if (!this._offlineHandlerRegistered) {
                        this._offlineHandlerRegistered = true;
                        window.addEventListener('offline', () => {
                            if (options.debug) log.info('Network offline');
                            this._handleDisconnectCleanup();
                        });
                    }

                    rws.addEventListener('close', (event) => {
                        log.info(`Kodi WebSocket Disconnected:`, JSON.stringify({
                            code: event.code,
                            reason: event.reason || 'No reason provided',
                            wasClean: event.wasClean,
                            type: event.type
                        }, null, 4));

                        this._handleDisconnectCleanup({ useTimeout: false });

                        this._updateTimeRemainingInterval = setInterval(function () {
                            let labels;
                            // For PVR we get this info from the EPG...
                            if (this._currentMediaType === 'channel'){
                                labels = ['PVR.EpgEventRemainingTime', 'PVR.EpgEventFinishTime'];
                            }
                            // Otherwise, from the standard labels...
                            else {
                                labels = ['VideoPlayer.TimeRemaining', 'Player.FinishTime'];
                            }

                            sendKodiMessageOverWebSocket(rws, 'XBMC.GetInfoLabels', {
                                labels: labels,
                            });
                        }.bind(this), 1000);

                        // Don't add custom reconnection logic here - let PartySocket handle it
                        log.info('WebSocket closed, PartySocket will handle reconnection automatically');
                    });

                    rws.addEventListener('message', (event) => {
                        const data = JSON.parse(event.data);

                        // Handle ping responses (don't process further)
                        if (data.id === 'health-check-ping') {
                            return;
                        }

                        let json_result = data;
                        log.info('Websocket [message]:');
                        // This logs the whole json response from Kodi nicely and means we don't need to log this individually below
                        log.info(JSON.stringify(json_result, null, 4));

                        //////////////////////////////////////////////////////
                        // RESULTS PROCESSING!

                        if (json_result.id === "Player.GetItem") {
                            log.info("Processing result for: Player.GetItem");

                            let results = json_result.result;
                            this.title = results.item.title || '';
                            this.season = (results.item.season ?? '');
                            this.episode = (results.item.episode ?? '');
                            this.premiered = (results.item.premiered ?? '');
                            this._currentMediaType = results.item.type;

                            let artworkUrl = null;

                            if (results.item.art && typeof results.item.art === 'object') {
                                const art = results.item.art;

                                this.artworks = Object.entries(art)
                                    .filter(([, value]) => typeof value === 'string' && value.length > 0)
                                    .map(([key, value]) => ({
                                        key,
                                        raw: value,
                                        url: normaliseKodiArtworkUrl(value),
                                    }))
                                    .filter((entry) => entry.url);

                                if (art["album.thumb"]) {
                                    log.info("Artwork: using [album.thumb]")
                                    artworkUrl = art["album.thumb"];
                                }
                                else if (art["tvshow.poster"]) {
                                    log.info("Artwork: using [tvshow.poster]")
                                    artworkUrl = art["tvshow.poster"];
                                }
                                else if (art["movie.poster"]) {
                                    log.info("Artwork: using [movie.poster]")
                                    artworkUrl = art["movie.poster"];
                                }
                                else if (art["poster"]) {
                                    log.info("Artwork: using [poster]")
                                    artworkUrl = art["poster"];
                                }
                                else if (art["thumb"]) {
                                    log.info("Artwork: using [thumb]")
                                    artworkUrl = art["thumb"];
                                }
                                else if (art["icon"]) {
                                    log.info("Artwork: using [icon]")
                                    artworkUrl = art["icon"];
                                }
                            }
                            else if (results.item.thumbnail) {
                                log.info("Artwork: using fallback thumbnail")
                                artworkUrl = results.item.thumbnail;
                            }

                            if (artworkUrl) {
                                const kodiArtworkUrl = normaliseKodiArtworkUrl(artworkUrl);
                                if (kodiArtworkUrl) {
                                    log.info("Final artwork URL:", kodiArtworkUrl);
                                    this.artwork = kodiArtworkUrl;
                                }
                            }

                            // & Kick off the update of time remaining every x milliseconds
                            let type = results.item.type;

                            let labels = [];
                            // For PVR we get this info from the EPG...
                            if (type === 'channel'){
                                labels = ['PVR.EpgEventRemainingTime', 'PVR.EpgEventFinishTime']
                            }
                            // Otherwise, from the standard labels...
                            else {
                                labels = ['VideoPlayer.TimeRemaining', 'Player.FinishTime']
                            }
                            if (this._updateTimeRemainingInterval) {
                                clearInterval(this._updateTimeRemainingInterval);
                                this._updateTimeRemainingInterval = null;
                            }
                            this._updateTimeRemainingInterval = setInterval(function () {
                                sendKodiMessageOverWebSocket(rws, 'XBMC.GetInfoLabels', {
                                    labels: labels,
                                })
                            }, 1000);

                            // Kodi is playing and info will soon be available, so show our component, but give it a moment...
                            setTimeout(() => {
                                Alpine.store('isAvailable').kodi = true;
                            }, 1000);
                        }

                        // Get Time Remaining and Finish time - varies for PVR vs. other types of playback...
                        if (json_result.id === "XBMC.GetInfoLabels") {
                            log.info("Processing result for: XBMC.GetInfoLabels");

                            let results = json_result.result;
                            // Remaining time
                            const remainingTime = results["PVR.EpgEventRemainingTime"] || results["VideoPlayer.TimeRemaining"] || '';
                            const temp = typeof remainingTime === 'string' ? remainingTime.replace(/^0(?:0:0?)?/, '') : '';
                            this.timeRemainingAsTime = temp !== '' ? '-' + temp : '';
                            // Finish time
                            const finishTime = results["PVR.EpgEventFinishTime"] || results["Player.FinishTime"] || '';
                            log.info("Time Remaining is " + this.timeRemainingAsTime);
                            log.info("Kodi finish time is " + finishTime);
                            this.finishTime = typeof finishTime === 'string'
                                ? finishTime.replace(' PM','pm').replace(' AM','am')
                                : '';
                        }

                        //////////////////////////////////////////////////////
                        // NOTIFICATIONS!

                        // We've either got a notification playback has started, or the result of the initial request for active players
                        if (json_result.method === "Player.OnPlay" || json_result.id === "Player.GetActivePlayers") {

                            let playerId = null;

                            // Responding to request to Kodi Player.GetActivePlayers
                            if (json_result.id === "Player.GetActivePlayers") {
                                log.info("Processing result for: Player.GetActivePlayers")

                                if (json_result.result.length === 0) {
                                    log.info("Kodi is not playing.");
                                    return;
                                } else {
                                    // Playing music
                                    if (json_result.result[0].playerid === 0) {
                                        playerId = 0;
                                    }
                                    // Playing a stream or video
                                    else if (json_result.result[0].playerid === 1 || json_result.result[0].playerid === -1) {
                                        playerId = 1;
                                    }
                                }
                            }
                            // Responding to Kodi Notification: Player.OnPlay
                            else {
                                log.info("Kodi Notification: Player.OnPlay");
                                playerId = json_result.params.data.player.playerid;
                            }

                            if (playerId === -1) {
                                log.info("Player ID was -1 (stream?) - let's assume video...");
                                playerId = 1;
                            }
                            // Playing pictures?  Just stay on the weather display
                            if (playerId === 2) {
                                log.info("Player ID is 2, displaying pictures, so do nothing.")
                                return;
                            }

                            log.info("Playback has started with playerid", playerId);

                            // Kodi playing - so first get static data - what is playing, artwork urls etc.
                            // Once this returns, the handler above will kick off the update of time remaining.
                            sendKodiMessageOverWebSocket(rws, 'Player.GetItem', {
                                properties: [
                                    'art',
                                    'title',
                                    'season',
                                    'episode',
                                    'endtime',
                                    'premiered',
                                ],
                                playerid: playerId,
                            })
                        }

                        if (json_result.method === "Player.OnStop") {
                            log.info("Kodi: Player.OnStop");
                            this._handleDisconnectCleanup({ useTimeout: false });
                        }

                    });

                } catch (error) {
                    log.error('Failed to create WebSocket:', error);
                    Alpine.store('isAvailable').kodi = false;
                }
            }, 500);
        },

        _clearProperties() {
            // log.info("Clearing Kodi properties");
            this.artwork = null;
            this.artworks = [];
            this.title = '';
            this.season = '';
            this.episode = '';
            this.finishTime = '';
            this.timeRemainingAsTime = '';
            this.premiered = '';
        },

        _handleDisconnectCleanup(options = {}) {
            const {
                useTimeout = true,
                clearUpdateInterval = true,
                clearPingInterval = true
            } = options;

            if (useTimeout) {
                setTimeout(() => {
                    this._clearProperties();
                }, 2000);
            } else {
                this._clearProperties();
            }

            Alpine.store('isAvailable').kodi = false;

            if (clearUpdateInterval && this._updateTimeRemainingInterval) {
                clearInterval(this._updateTimeRemainingInterval);
                this._updateTimeRemainingInterval = null;
            }

            if (clearPingInterval && pingInterval) {
                clearInterval(pingInterval);
                pingInterval = null;
            }
        },

        init() {
            // If we're not set up to use Kodi, we're done...
            if (Alpine.store('config').mediaSource !== 'kodi'){
                log.info("Media source is not set to kodi, doing nothing.");
                return;
            }
            // Kick this off two seconds after we fire up, just to give time for things to settle a bit...
            this._initDelay = setTimeout(() => {
                log.info("KodiComponent init");
                log.info(`Kodi Host: ${Alpine.store('config').kodi} (&kodi, default 127.0.0.1)`);
                log.info(`Kodi JSON Port: ${Alpine.store('config').kodiJsonPort} (&kodi-json, default 9090)`);
                log.info(`Kodi Web Port: ${Alpine.store('config').kodiWebPort} (&kodi-web, default 8080)`);
                log.info(`Kodi SSL: ${Alpine.store('config').kodiSSL} (&kodi-ssl, default false)`);
                this.createEnhancedKodiWebSocket();
            }, 2000)
        },
    }
};


// {
//     "id": "Player.GetItem",
//     "jsonrpc": "2.0",
//     "result": {
//         "item": {
//             "art": {
//                 "clearlogo": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fLogo%2f0%3fFormat%3doriginal%26Tag%3dd7a1ad466bbf9cbcba384bafa9d826e8/",
//                 "fanart": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fBackdrop%2f0%3fFormat%3doriginal%26Tag%3df4378d21297161018a134f2248e6d78d/",
//                 "icon": "image://DefaultVideo.png/",
//                 "landscape": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fThumb%2f0%3fFormat%3doriginal/",
//                 "poster": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fPrimary%2f0%3fFormat%3doriginal%26Tag%3dec1d614b8ea1fad81ce11cd3cd02a4d9/",
//                 "thumb": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2f871553f09f3856b8d4aa75537be26083%2fImages%2fPrimary%2f0%3fFormat%3doriginal%26Tag%3dec111a970e519d7aa3af6d07701c9e58/",
//                 "tvshow.banner": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fBanner%2f0%3fFormat%3doriginal%26Tag%3d3d832e1ef735bf7c03eee6f5fa172163/",
//                 "tvshow.clearlogo": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fLogo%2f0%3fFormat%3doriginal%26Tag%3dd7a1ad466bbf9cbcba384bafa9d826e8/",
//                 "tvshow.fanart": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fBackdrop%2f0%3fFormat%3doriginal%26Tag%3df4378d21297161018a134f2248e6d78d/",
//                 "tvshow.landscape": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fThumb%2f0%3fFormat%3doriginal/",
//                 "tvshow.poster": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fPrimary%2f0%3fFormat%3doriginal%26Tag%3dec1d614b8ea1fad81ce11cd3cd02a4d9/",
//                 "tvshow.thumb": "image://http%3a%2f%2f100.79.172.11%3a8096%2fItems%2fe8ec6af526a793ad1436314fdfe517b7%2fImages%2fPrimary%2f0%3fFormat%3doriginal%26Tag%3dec1d614b8ea1fad81ce11cd3cd02a4d9/"
//             },
//             "episode": 2,
//             "id": 554,
//             "label": "Jon Richardson & Roisin Conaty, Rob Beckett & Kiell Smith-Bynoe, Lou Wall",
//             "season": 29,
//             "title": "Jon Richardson & Roisin Conaty, Rob Beckett & Kiell Smith-Bynoe, Lou Wall",
//             "type": "episode"
//         }
//     }
// }