# SoundSync

SoundSync is a real-time audio synchronization web application that allows multiple users on the same network to listen to audio together. The first user to connect becomes the host and controls the audio playback, while all other users' audio is synchronized with the host.

## Features

- Real-time audio synchronization across devices
- Automatic host designation (first user to connect)
- Host can upload and control audio playback
- Smooth time synchronization for all connected clients
- List of connected users
- Responsive design

## Technologies Used

- Node.js and Express for the server
- Socket.IO for real-time communication
- HTML5 Audio API for audio playback
- Vanilla JavaScript for client-side functionality
- CSS for styling

## Getting Started

### Prerequisites

- Node.js (v12 or higher)
- npm (v6 or higher)

### Installation

1. Clone the repository

```
git clone <repository-url>
```

2. Navigate to the project directory

```
cd soundsync
```

3. Install dependencies

```
npm install
```

4. Start the server

```
npm run dev
```

5. Open your browser and navigate to `http://localhost:3000`

## How to Use

1. Open the application in a browser on your device
2. The first user to connect becomes the host
3. The host can upload an audio file using the file input
4. When the host plays the audio, all connected clients will hear the same audio in sync
5. The host can pause, play, and seek the audio, and all clients will follow

## Note on Network Connectivity

For the best experience, all devices should be connected to the same network. This ensures minimal latency and optimal synchronization.

## License

This project is licensed under the ISC License.
