Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6Ik5zNEo3dW5MYk1hY0xoTWoiLCJqdGkiOiI3M2ZmZTQ2Ny05OWZjLTQ4MWUtOTJhNi1lNmYyYTYyYmM3ZWIiLCJpZCI6NTIwNTUwLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3OTE3MzAwMDN9.lKIJRCIJVD4NZ_KGVcW1649ngnyPqrVUuU6vl3HdLVY';

const viewer = new Cesium.Viewer('cesiumContainer', {
    terrain: Cesium.Terrain.fromWorldTerrain(),
    baseLayerPicker: false, homeButton: false, navigationHelpButton: false,
    animation: false, timeline: false, fullscreenButton: false, infoBox: false,
});
viewer.scene.globe.enableLighting = false; 
viewer.scene.globe.depthTestAgainstTerrain = true;

let simulationEntity = null;
let mediaRecorder;
let recordedChunks = [];

window.startSimulation = function(geoJsonData) {
    let data = typeof geoJsonData === 'string' ? JSON.parse(geoJsonData) : geoJsonData;

    // Xóa dữ liệu cũ
    if (simulationEntity) viewer.entities.remove(simulationEntity);
    viewer.entities.values.forEach(entity => { if (entity.polyline) viewer.entities.remove(entity); });
    
    let coordinates = [];
    data.features.forEach(feature => {
        if (feature.geometry.type === 'LineString') coordinates = feature.geometry.coordinates; 
    });
    if (coordinates.length < 2) return;

    // Vẽ đường
    const routePositions = coordinates.map(coord => Cesium.Cartesian3.fromDegrees(coord[0], coord[1], (coord[2] || 0) + 2)); 
    viewer.entities.add({
        polyline: { positions: routePositions, width: 5, material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.2, color: Cesium.Color.ORANGE }), clampToGround: true }
    });

    const positionProperty = new Cesium.SampledPositionProperty();
    const startTime = Cesium.JulianDate.now();
    let stopTime = startTime;
    const speedMps = 25; // Tốc độ bay (nhanh một chút để video không quá dài)
    let accumulatedTime = 0;

    for (let i = 0; i < coordinates.length; i++) {
        const coord = coordinates[i];
        const position = Cesium.Cartesian3.fromDegrees(coord[0], coord[1], (coord[2] || 0) + 1.5); 
        if (i === 0) {
            positionProperty.addSample(startTime, position);
        } else {
            const prevCoord = coordinates[i - 1];
            const prevPosition = Cesium.Cartesian3.fromDegrees(prevCoord[0], prevCoord[1], (prevCoord[2] || 0) + 1.5);
            accumulatedTime += Cesium.Cartesian3.distance(prevPosition, position) / speedMps;
            const time = Cesium.JulianDate.addSeconds(startTime, accumulatedTime, new Cesium.JulianDate());
            positionProperty.addSample(time, position);
            stopTime = time;
        }
    }

    viewer.clock.startTime = startTime.clone();
    viewer.clock.stopTime = stopTime.clone();
    viewer.clock.currentTime = startTime.clone();
    viewer.clock.clockRange = Cesium.ClockRange.CLAMPED; 
    viewer.clock.multiplier = 1; 

    simulationEntity = viewer.entities.add({
        position: positionProperty,
        orientation: new Cesium.VelocityOrientationProperty(positionProperty), 
        point: { pixelSize: 15, color: Cesium.Color.YELLOW, outlineColor: Cesium.Color.WHITE, outlineWidth: 3 },
    });
    viewer.trackedEntity = simulationEntity;
    
    viewer.flyTo(simulationEntity, { offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(0), Cesium.Math.toRadians(-35), 800) });

    // ==============================================
    // BẮT ĐẦU QUAY VIDEO MÀN HÌNH BẰNG MEDIARECORDER
    // ==============================================
    setTimeout(() => {
        document.getElementById('recordingOverlay').style.display = 'flex'; // Hiện chữ "Đang dựng Video"
        
        const canvas = viewer.canvas;
        const stream = canvas.captureStream(30); // 30 FPS
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        recordedChunks = [];

        mediaRecorder.ondataavailable = function(e) {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = function() {
            document.getElementById('progressText').innerText = "Đang xuất file...";
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            
            // Chuyển Blob thành Base64 để gửi về Flutter
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = function() {
                const base64data = reader.result;
                // Gửi dữ liệu về Flutter thông qua kênh DnaVideoChannel
                if (window.DnaVideoChannel) {
                    window.DnaVideoChannel.postMessage(base64data);
                }
            }
        };

        mediaRecorder.start();

        // Tính thời gian quay video = tổng thời gian bay (accumulatedTime) + 2 giây dư
        const totalDurationMs = (accumulatedTime + 2) * 1000;
        let elapsed = 0;
        const progressInterval = setInterval(() => {
            elapsed += 500;
            let percent = Math.min(Math.round((elapsed / totalDurationMs) * 100), 100);
            document.getElementById('progressText').innerText = percent + "%";
            if (elapsed >= totalDurationMs) {
                clearInterval(progressInterval);
                mediaRecorder.stop(); // Dừng quay
            }
        }, 500);

    }, 3000); // Đợi 3 giây cho camera zoom xuống mặt đất rồi mới bắt đầu quay
};
