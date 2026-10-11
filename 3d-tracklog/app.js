// 1. CHÚ Ý QUAN TRỌNG: Cần đăng ký tài khoản Cesium ion miễn phí tại cesium.com/ion
// Để lấy Token hiển thị địa hình đồi núi (World Terrain) và Ảnh vệ tinh.
Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6Il9hMVpDdk1kYWpHMVZaNGoiLCJqdGkiOiJlMDA4ZWMwZS1hZWQ0LTQzNmItOTllYS00NGZkYTE1YTgwMDQiLCJpZCI6NTIwNTUwLCJzdWIiOiJETkFQbHVnaW4iLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoiRE5BUGx1Z2luIiwiaWF0IjoxNzkxNzMwMjkzfQ.OKqAc6xLlWHzm4-pJrH33cdrukkM0EAfcUajPLsyjME';

// 2. Khởi tạo Cesium Viewer
const viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: Cesium.createWorldTerrain(), // Bật địa hình 3D lồi lõm
    baseLayerPicker: false,
    homeButton: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
});

// Bật hiệu ứng đổ bóng địa hình và ánh sáng mặt trời cho chân thực
viewer.scene.globe.enableLighting = true;
viewer.scene.globe.depthTestAgainstTerrain = true;

let simulationEntity = null;

// ==============================================================
// HÀM GIAO TIẾP VỚI FLUTTER: Flutter sẽ gọi hàm này và truyền GeoJSON vào
// ==============================================================
window.startSimulation = function(geoJsonData) {
    let data;
    try {
        data = typeof geoJsonData === 'string' ? JSON.parse(geoJsonData) : geoJsonData;
    } catch (e) {
        console.error("Dữ liệu không hợp lệ", e);
        return;
    }

    // Xóa dữ liệu cũ nếu có
    viewer.entities.removeAll();
    
    // Tìm LineString (Tuyến đường) trong GeoJSON
    let coordinates = [];
    data.features.forEach(feature => {
        if (feature.geometry.type === 'LineString') {
            coordinates = feature.geometry.coordinates; // [ [lon, lat, alt?], ... ]
        }
    });

    if (coordinates.length < 2) return;

    // 1. Vẽ đường Line dẫn đường màu cam nổi bật trên đồi núi
    const routePositions = coordinates.map(coord => Cesium.Cartesian3.fromDegrees(coord[0], coord[1], (coord[2] || 0) + 2)); // Nâng lên 2m khỏi mặt đất
    
    viewer.entities.add({
        polyline: {
            positions: routePositions,
            width: 5,
            material: new Cesium.PolylineGlowMaterialProperty({
                glowPower: 0.2,
                color: Cesium.Color.ORANGE,
            }),
            clampToGround: true // Ôm sát đồi núi
        }
    });

    // 2. Tạo thuộc tính nội suy theo thời gian (SampledPositionProperty)
    const positionProperty = new Cesium.SampledPositionProperty();
    const startTime = Cesium.JulianDate.now();
    let stopTime = startTime;

    // Giả lập tốc độ di chuyển: 5 mét / giây
    const speedMps = 5; 
    let accumulatedTime = 0;

    for (let i = 0; i < coordinates.length; i++) {
        const coord = coordinates[i];
        const position = Cesium.Cartesian3.fromDegrees(coord[0], coord[1], (coord[2] || 0) + 1.5); // Điểm di chuyển cách mặt đất 1.5m
        
        if (i === 0) {
            positionProperty.addSample(startTime, position);
        } else {
            const prevCoord = coordinates[i - 1];
            const prevPosition = Cesium.Cartesian3.fromDegrees(prevCoord[0], prevCoord[1], (prevCoord[2] || 0) + 1.5);
            
            // Tính khoảng cách giữa 2 điểm để ra thời gian
            const distance = Cesium.Cartesian3.distance(prevPosition, position);
            const timeToTravel = distance / speedMps;
            
            accumulatedTime += timeToTravel;
            const time = Cesium.JulianDate.addSeconds(startTime, accumulatedTime, new Cesium.JulianDate());
            positionProperty.addSample(time, position);
            stopTime = time;
        }
    }

    // Thiết lập thời gian đồng hồ Cesium
    viewer.clock.startTime = startTime.clone();
    viewer.clock.stopTime = stopTime.clone();
    viewer.clock.currentTime = startTime.clone();
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP; // Chạy hết thì lặp lại
    viewer.clock.multiplier = 1; // Tốc độ thời gian thực 1x

    // 3. Tạo Entity di chuyển (Hạt chấm phát sáng hoặc Mô hình 3D)
    simulationEntity = viewer.entities.add({
        position: positionProperty,
        orientation: new Cesium.VelocityOrientationProperty(positionProperty), // Tự động xoay đầu theo hướng đi
        point: {
            pixelSize: 15,
            color: Cesium.Color.YELLOW,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 3
        },
        // Nếu bạn có file .gltf (như ô tô, con người, drone), có thể dùng:
        // model: { uri: 'assets/drone.gltf', scale: 2.0 }
    });

    // 4. Khóa Camera bám theo đối tượng (Góc nhìn chim bay chéo từ phía sau)
    viewer.trackedEntity = simulationEntity;
    
    // Zoom tới điểm bắt đầu
    viewer.flyTo(simulationEntity, {
        offset: new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(0), 
            Cesium.Math.toRadians(-35), // Nghiêng góc 35 độ nhìn xuống đồi núi
            800 // Cách đối tượng 800m
        )
    });
};

// ==============================================================
// Xử lý nút Tạm dừng / Tiếp tục
// ==============================================================
document.getElementById('btnPlayPause').addEventListener('click', function() {
    const clock = viewer.clock;
    clock.shouldAnimate = !clock.shouldAnimate;
    this.innerText = clock.shouldAnimate ? "Tạm dừng" : "Tiếp tục";
});
