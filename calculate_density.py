import osmnx as ox

def get_building_density(lat, lon, radius_m=100):
    """
    Fetch buildings within radius_m meters of (lat, lon) from OSM
    Returns low, moderate, or high
    """
    try:
        # building footprints within 100m
        buildings = ox.features_from_point((lat, lon), tags={"building": True}, dist=radius_m)
        
        count = len(buildings)
        
        if count < 20:
            return "Low"
        elif count < 50:
            return "Moderate"
        else:
            return "High"
    except Exception as e:
        print(f"osm building error: {e}")
        return "Low"