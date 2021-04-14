import * as os from 'os'

export default {
  // Signaling settings (protoo WebSocket server and HTTP API server).
  https: {
    listenIp: process.env.HTTPS_LISTEN_IP as string,
    // NOTE: Don't change listenPort (client app assumes 4443).
    listenPort: process.env.HTTPS_LISTEN_PORT as string,
    // NOTE: Set your own valid certificate files.
    tls: {
      cert: process.env.HTTPS_CERT_FULLCHAIN as string,
      key: process.env.HTTPS_CERT_PRIVKEY as string,
    },
  },
  // mediasoup settings.
  mediasoup: {
    // Number of mediasoup workers to launch.
    numWorkers: Object.keys(os.cpus()).length,
    // mediasoup WorkerSettings.
    // See https://mediasoup.org/documentation/v3/mediasoup/api/#WorkerSettings
    workerSettings: {
      logLevel: 'warn' as const,
      logTags: [
        'info' as const,
        'ice' as const,
        'dtls' as const,
        'rtp' as const,
        'srtp' as const,
        'rtcp' as const,
        'rtx' as const,
        'bwe' as const,
        'score' as const,
        'simulcast' as const,
        'svc' as const,
        'sctp' as const,
      ],
      rtcMinPort: process.env.MEDIASOUP_MIN_PORT as string,
      rtcMaxPort: process.env.MEDIASOUP_MAX_PORT as string,
    },
    // mediasoup Router options.
    // See https://mediasoup.org/documentation/v3/mediasoup/api/#RouterOptions
    routerOptions: {
      mediaCodecs: [
        {
          kind: 'audio' as const,
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: 'video' as const,
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video' as const,
          mimeType: 'video/VP9',
          clockRate: 90000,
          parameters: {
            'profile-id': 2,
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video' as const,
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '4d0032',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
        {
          kind: 'video' as const,
          mimeType: 'video/h264',
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
            'x-google-start-bitrate': 1000,
          },
        },
      ],
    },
    // mediasoup WebRtcTransport options for WebRTC endpoints (mediasoup-client,
    // libmediasoupclient).
    // See https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
    webRtcTransportOptions: {
      listenIps: [
        {
          ip: process.env.MEDIASOUP_LISTEN_IP as string,
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP as string,
        },
      ],
      initialAvailableOutgoingBitrate: 1000000,
      minimumAvailableOutgoingBitrate: 600000,
      maxSctpMessageSize: 262144,
      // Additional options that are not part of WebRtcTransportOptions.
      maxIncomingBitrate: 1500000,
    },
    // mediasoup PlainTransport options for legacy RTP endpoints (FFmpeg,
    // GStreamer).
    // See https://mediasoup.org/documentation/v3/mediasoup/api/#PlainTransportOptions
    plainTransportOptions: {
      listenIp: {
        ip: process.env.MEDIASOUP_LISTEN_IP as string,
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP as string,
      },
      maxSctpMessageSize: 262144,
    },
  },
}
