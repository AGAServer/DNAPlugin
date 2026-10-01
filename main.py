from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import rasterio
from rasterio.windows import from_bounds
import numpy as np
from rasterio import features
import geopandas as gpd
from shapely.geometry import shape
import json

app = FastAPI()

# Model nhận dữ liệu từ App Flutter
class AnalysisRequest(BaseModel):
    bbox: list[float]  # [minLon, minLat, maxLon, maxLat]
    old_b4: str
    old_b8: str
    old_b11: str
    old_scl: str
    new_b4: str
    new_b8: str
    new_b11: str
    new_scl: str
    min_old: float
    drop: float

def read_band_window(url, bbox):
    """Đọc một khung dữ liệu nhỏ (window) từ URL ảnh vệ tinh gốc dựa trên BBOX"""
    with rasterio.open(url) as src:
        # Chuyển BBOX sang hệ tọa độ của ảnh (thường là UTM)
        window = from_bounds(bbox[0], bbox[1], bbox[2], bbox[3], src.transform)
        # Lấy dữ liệu ma trận ảnh
        data = src.read(1, window=window)
        # Lấy transform của khung nhỏ này để lát tính tọa độ thực
        win_transform = src.window_transform(window)
        return data.astype(np.float32), win_transform, src.crs

@app.post("/api/forest-change")
async def analyze_forest_change(req: AnalysisRequest):
    try:
        # 1. Đọc dữ liệu ảnh vệ tinh dựa trên BBOX
        b4_old, transform, crs = read_band_window(req.old_b4, req.bbox)
        b8_old, _, _ = read_band_window(req.old_b8, req.bbox)
        b11_old, _, _ = read_band_window(req.old_b11, req.bbox)
        scl_old, _, _ = read_band_window(req.old_scl, req.bbox)
        
        b4_new, _, _ = read_band_window(req.new_b4, req.bbox)
        b8_new, _, _ = read_band_window(req.new_b8, req.bbox)
        b11_new, _, _ = read_band_window(req.new_b11, req.bbox)
        scl_new, _, _ = read_band_window(req.new_scl, req.bbox)

        # 2. Loại bỏ mây (SCL Mask) theo đúng logic từ QGIS
        # Loại các mã 3 (mây mù), 8 (mây trung bình), 9 (mây dày), 10 (bóng mây)
        cloud_mask = ~np.isin(scl_old, [3, 8, 9, 10]) & ~np.isin(scl_new, [3, 8, 9, 10])

        # 3. Tính toán NDVI và NDMI
        ndvi_old = 100.0 * (b8_old - b4_old) / (b8_old + b4_old + 0.0001)
        ndvi_new = 100.0 * (b8_new - b4_new) / (b8_new + b4_new + 0.0001)
        
        ndmi_old = 100.0 * (b8_old - b11_old) / (b8_old + b11_old + 0.0001)
        ndmi_new = 100.0 * (b8_new - b11_new) / (b8_new + b11_new + 0.0001)

        # 4. Áp dụng bộ lọc độ nhạy (Công thức QgsRasterCalculator)
        change_mask = (
            cloud_mask & 
            (ndvi_old >= req.min_old) & 
            ((ndvi_old - ndvi_new) >= req.drop) & 
            ((ndmi_old - ndmi_new) >= (req.drop - 15))
        )

        # 5. Chuyển đổi Pixel (Raster) thành Đa giác (Vector)
        mask = change_mask.astype(np.uint8)
        geoms = []
        for geom, val in features.shapes(mask, transform=transform):
            if val == 1: # Chỉ lấy các vùng bị biến động
                geoms.append(shape(geom))
                
        if not geoms:
            return {"type": "FeatureCollection", "features": []}

        # 6. Xử lý hình học bằng GeoPandas (Gộp, Buffer, Lọc diện tích)
        gdf = gpd.GeoDataFrame(geometry=geoms, crs=crs)
        
        # Chuyển về hệ tọa độ UTM để tính diện tích chính xác (mét)
        gdf_utm = gdf.to_crs(gdf.estimate_utm_crs())
        
        # Gộp các vùng dính nhau, làm mượt bằng Buffer 15m và -14.9m
        union_geom = gdf_utm.geometry.unary_union
        dilated = union_geom.buffer(15.0, resolution=3)
        closed = dilated.buffer(-14.9, resolution=3)
        
        if closed.is_empty:
             return {"type": "FeatureCollection", "features": []}
             
        if closed.geom_type == 'Polygon':
            parts = [closed]
        else:
            parts = list(closed.geoms)

        # Lọc các lô >= 0.01 ha (100 m2) và đơn giản hóa đường viền (simplify)
        final_features = []
        for part in parts:
            smooth_part = part.simplify(2.0)
            area_ha = smooth_part.area / 10000.0
            if area_ha >= 0.01:
                final_features.append({"geometry": smooth_part, "DienTich_ha": round(area_ha, 4)})

        if not final_features:
            return {"type": "FeatureCollection", "features": []}

        gdf_final = gpd.GeoDataFrame(final_features, crs=gdf_utm.crs)
        # Chuyển lại về WGS84 để App Flutter vẽ lên bản đồ
        gdf_final = gdf_final.to_crs("EPSG:4326")

        return json.loads(gdf_final.to_json())

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
