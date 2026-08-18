document.addEventListener('DOMContentLoaded', () => {
    // Initialize Leaflet Map (San Francisco)
    const map = L.map('map', { zoomControl: false, attributionControl: false }).setView([37.7749, -122.4194], 14);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);

    const markerIcon = L.divIcon({
        className: 'user-marker',
        html: '<div style="background-color: black; width: 16px; height: 16px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.3);"></div>',
        iconSize: [16, 16], iconAnchor: [8, 8]
    });
    L.marker([37.7749, -122.4194], { icon: markerIcon }).addTo(map);

    // Fetch user profile from /api/me (Google SSO)
    fetch('/api/me')
        .then(res => res.json())
        .then(data => {
            if (data.authenticated) {
                const badge = document.getElementById('userProfileBadge');
                const avatar = document.getElementById('userAvatar');
                const name = document.getElementById('userName');
                if (badge && avatar && name) {
                    if (data.picture) avatar.src = data.picture;
                    else avatar.style.display = 'none';
                    name.textContent = data.name ? data.name.split(' ')[0] : data.email;
                    badge.style.display = 'flex';
                }
            }
        })
        .catch(() => {});

    // DOM Elements
    const startBtn = document.getElementById('startVoiceBtn');
    const closeBtn = document.getElementById('closeVoiceBtn');
    const voiceSheet = document.getElementById('voiceSheet');
    const searchBar = document.getElementById('searchBar');
    const waveform = document.getElementById('waveform');
    const statusText = document.getElementById('statusText');
    const ttfbValue = document.getElementById('ttfbValue');

    // Create waveform bars
    const numBars = 30;
    for (let i = 0; i < numBars; i++) {
        const bar = document.createElement('div');
        bar.className = 'bar';
        waveform.appendChild(bar);
    }
    const bars = document.querySelectorAll('.bar');

    let isListening = false;
    let geminiLive = null;

    startBtn.addEventListener('click', async () => {
        if (isListening) return;

        voiceSheet.classList.add('open');
        searchBar.style.transform = 'translateY(20px)';
        searchBar.style.opacity = '0';
        searchBar.style.pointerEvents = 'none';
        isListening = true;
        statusText.innerHTML = 'Connecting...';

        // Connect via backend WebSocket proxy (no client-side API key required)
        geminiLive = new GeminiLive({
            onStatus: (status) => {
                if (status === 'Connected') {
                    statusText.innerHTML = 'How can I assist<br>you today?';
                } else if (status === 'Connecting...') {
                    statusText.innerHTML = 'Connecting...';
                } else {
                    statusText.innerHTML = `<span style="color: red; font-size: 16px">${status}</span>`;
                }
            },
            onToolCall: (toolCall) => {
                console.log('Tool Call:', toolCall);
                statusText.innerHTML = `Executing:<br>${toolCall.name}`;
                setTimeout(() => { 
                    statusText.innerHTML = 'How can I assist<br>you today?'; 
                }, 2500);
            },
            onText: (text) => {
                console.log('Gemini text:', text);
            },
            onLatency: (ttfb) => {
                ttfbValue.innerText = ttfb + ' ms';
                ttfbValue.style.color = ttfb < 400 ? '#00ffcc' : (ttfb < 800 ? '#ffcc00' : '#ff4444');
            },
            onVolume: (rms) => {
                // Smooth live mic volume driving waveform height
                const h = Math.min(60, Math.max(6, Math.floor(rms * 2500)));
                bars.forEach((bar, i) => {
                    const variance = Math.sin(i * 0.5 + Date.now() * 0.005) * 0.3 + 0.7;
                    bar.style.height = `${Math.max(6, Math.floor(h * variance))}px`;
                });
            },
            onDebug: (msg) => {
                console.log('[GEMINI]', msg);
                if (msg === 'Gemini speaking...') {
                    statusText.innerHTML = 'Gemini is speaking...';
                } else if (msg === 'Interrupted — listening...' || msg === 'Listening...') {
                    statusText.innerHTML = 'How can I assist<br>you today?';
                }
            }
        });

        await geminiLive.connect();
    });

    closeBtn.addEventListener('click', () => {
        voiceSheet.classList.remove('open');
        searchBar.style.transform = 'translateY(0)';
        searchBar.style.opacity = '1';
        searchBar.style.pointerEvents = 'auto';
        isListening = false;

        if (geminiLive) {
            geminiLive.disconnect();
            geminiLive = null;
        }

        bars.forEach(bar => { bar.style.height = '10px'; });
        statusText.innerHTML = 'Your AI Concierge<br>is listening...';
    });
});
