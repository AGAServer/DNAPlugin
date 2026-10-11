// 1. DÁN MÃ TOKEN API CỦA ANH VÀO GIỮA 2 DẤU NHÁY ĐƠN DƯỚI ĐÂY:
Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6Ik5zNEo3dW5MYk1hY0xoTWoiLCJqdGkiOiI3M2ZmZTQ2Ny05OWZjLTQ4MWUtOTJhNi1lNmYyYTYyYmM3ZWIiLCJpZCI6NTIwNTUwLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3OTE3MzAwMDN9.lKIJRCIJVD4NZ_KGVcW1649ngnyPqrVUuU6vl3HdLVY';

// 2. Khởi tạo Bản đồ (Đã dùng cú pháp mới nhất để chống lỗi đen màn hình)
const viewer = new Cesium.Viewer('cesiumContainer', {
    terrain: Cesium.Terrain.fromWorldTerrain(), // Bật địa hình 3D đồi núi
    baseLayerPicker: false,
    homeButton: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
});

// Bật hiệu ứng đổ bóng chân thực
viewer.scene.globe.enableLighting = true;
viewer.scene.globe.depthTestAgainstTerrain = true;

let simulationEntity = null;

// ==============================================================
// HÀM GIAO TIẾP VỚI FLUTTER: Nhận GeoJSON từ App và vẽ 3D
// ==============================================================
window.startSimulation = function(geoJsonData) {
    let data;
    try {
        data = typeof geoJsonData === 'string' ? JSON.parse(geoJsonData) : geoJsonData;
    } catch (e) {
        console.error("Dữ liệu không hợp lệ", e);
        return;
    }

    viewer.entities.removeAll();
    
    let coordinates = [];
    data.features.forEach(feature => {
        if (feature.geometry.type === 'LineString') {
            coordinates = feature.geometry.coordinates; 
        }
    });

    if (coordinates.length < 2) return;

    // Vẽ vệt đường Tracklog màu cam
    const routePositions = coordinates.map(coord => Cesium.Cartesian3.fromDegrees(coord[0], coord[1], (coord[2] || 0) + 2)); 
    
    viewer.entities.add({
        polyline: {
            positions: routePositions,
            width: 5,
            material: new Cesium.PolylineGlowMaterialProperty({
                glowPower: 0.2,
                color: Cesium.Color.ORANGE,
            }),
            clampToGround: true 
        }
    });

    // Nội suy thời gian di chuyển
    const positionProperty = new Cesium.SampledPositionProperty();
    const startTime = Cesium.JulianDate.now();
    let stopTime = startTime;

    const speedMps = 5; // Tốc độ giả lập
    let accumulatedTime = 0;

    for (let i = 0; i < coordinates.length; i++) {
        const coord = coordinates[i];
        const position = Cesium.Cartesian3.fromDegrees(coord[0], coord[1], (coord[2] || 0) + 1.5); 
        
        if (i === 0) {
            positionProperty.addSample(startTime, position);
        } else {
            const prevCoord = coordinates[i - 1];
            const prevPosition = Cesium.Cartesian3.fromDegrees(prevCoord[0], prevCoord[1], (prevCoord[2] || 0) + 1.5);
            
            const distance = Cesium.Cartesian3.distance(prevPosition, position);
            const timeToTravel = distance / speedMps;
            
            accumulatedTime += timeToTravel;
            const time = Cesium.JulianDate.addSeconds(startTime, accumulatedTime, new Cesium.JulianDate());
            positionProperty.addSample(time, position);
            stopTime = time;
        }
    }

    viewer.clock.startTime = startTime.clone();
    viewer.clock.stopTime = stopTime.clone();
    viewer.clock.currentTime = startTime.clone();
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP; 
    viewer.clock.multiplier = 1; 

    // Tạo đốm sáng di chuyển
    simulationEntity = viewer.entities.add({
        position: positionProperty,
        orientation: new Cesium.VelocityOrientationProperty(positionProperty), 
        point: {
            pixelSize: 15,
            color: Cesium.Color.YELLOW,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3
        },
    });

    viewer.trackedEntity = simulationEntity;
    
    // Zoom theo hướng chim bay
    viewer.flyTo(simulationEntity, {
        offset: new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(0), 
            Cesium.Math.toRadians(-35), 
            800 
        )
    });
};

// Xử lý nút Tạm dừng / Tiếp tục
document.getElementById('btnPlayPause').addEventListener('click', function() {
    const clock = viewer.clock;
    clock.shouldAnimate = !clock.shouldAnimate;
    this.innerText = clock.shouldAnimate ? "Tạm dừng" : "Tiếp tục";
});
