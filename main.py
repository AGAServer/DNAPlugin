from fastapi import FastAPI, HTTPException, UploadFile, File
from pydantic import BaseModel
import rasterio
from rasterio.windows import from_bounds
import numpy as np
from rasterio import features
import geopandas as gpd
from shapely.geometry import shape
import json
import tempfile
import os
import shutil

app = FastAPI()

class AnalysisRequest(BaseModel):
    bbox: list[float]
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
    with rasterio.open(url) as src:
        window = from_bounds(bbox[0], bbox[1], bbox[2], bbox[3], src.transform)
        data = src.read(1, window=window)
        win_transform = src.window_transform(window)
        return data.astype(np.float32), win_transform, src.crs

@app.post("/api/forest-change")
async def analyze_forest_change(req: AnalysisRequest):
    try:
        b4_old, transform, crs = read_band_window(req.old_b4, req.bbox)
        b8_old, _, _ = read_band_window(req.old_b8, req.bbox)
        b11_old, _, _ = read_band_window(req.old_b11, req.bbox)
        scl_old, _, _ = read_band_window(req.old_scl, req.bbox)
        
        b4_new, _, _ = read_band_window(req.new_b4, req.bbox)
        b8_new, _, _ = read_band_window(req.new_b8, req.bbox)
        b11_new, _, _ = read_band_window(req.new_b11, req.bbox)
        scl_new, _, _ = read_band_window(req.new_scl, req.bbox)

        cloud_mask = ~np.isin(scl_old, [3, 8, 9, 10]) & ~np.isin(scl_new, [3, 8, 9, 10])

        ndvi_old = 100.0 * (b8_old - b4_old) / (b8_old + b4_old + 0.0001)
        ndvi_new = 100.0 * (b8_new - b4_new) / (b8_new + b4_new + 0.0001)
        
        ndmi_old = 100.0 * (b8_old - b11_old) / (b8_old + b11_old + 0.0001)
        ndmi_new = 100.0 * (b8_new - b11_new) / (b8_new + b11_new + 0.0001)

        change_mask = (
            cloud_mask & 
            (ndvi_old >= req.min_old) & 
            ((ndvi_old - ndvi_new) >= req.drop) & 
            ((ndmi_old - ndmi_new) >= (req.drop - 15))
        )

        mask = change_mask.astype(np.uint8)
        geoms = []
        for geom, val in features.shapes(mask, transform=transform):
            if val == 1:
                geoms.append(shape(geom))
                
        if not geoms:
            return {"type": "FeatureCollection", "features": []}

        gdf = gpd.GeoDataFrame(geometry=geoms, crs=crs)
        gdf_utm = gdf.to_crs(gdf.estimate_utm_crs())
        
        union_geom = gdf_utm.geometry.unary_union
        dilated = union_geom.buffer(15.0, resolution=3)
        closed = dilated.buffer(-14.9, resolution=3)
        
        if closed.is_empty:
             return {"type": "FeatureCollection", "features": []}
             
        if closed.geom_type == 'Polygon':
            parts = [closed]
        else:
            parts = list(closed.geoms)

        final_features = []
        for part in parts:
            smooth_part = part.simplify(2.0)
            area_ha = smooth_part.area / 10000.0
            if area_ha >= 0.01:
                final_features.append({"geometry": smooth_part, "DienTich_ha": round(area_ha, 4)})

        if not final_features:
            return {"type": "FeatureCollection", "features": []}

        gdf_final = gpd.GeoDataFrame(final_features, crs=gdf_utm.crs)
        gdf_final = gdf_final.to_crs("EPSG:4326")

        return json.loads(gdf_final.to_json())

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# --- API XỬ LÝ FILE .TAB CHÈN THÊM VÀO ĐÂY ---
@app.post("/convert-tab/")
async def convert_tab(files: list[UploadFile] = File(...)):
    with tempfile.TemporaryDirectory() as tmpdirname:
        tab_file_path = None
        for file in files:
            file_path = os.path.join(tmpdirname, file.filename)
            with open(file_path, "wb") as f:
                shutil.copyfileobj(file.file, f)
            if file.filename.lower().endswith(".tab"):
                tab_file_path = file_path
        
        if not tab_file_path:
            return {"error": "Không tìm thấy file .tab trong danh sách tải lên"}
        
        try:
            gdf = gpd.read_file(tab_file_path)
            if gdf.crs and gdf.crs.to_epsg() != 4326:
                gdf = gdf.to_crs(epsg=4326)
            
            geojson_data = gdf.to_json()
            return {"geojson": json.loads(geojson_data)}
        except Exception as e:
            return {"error": str(e)}
