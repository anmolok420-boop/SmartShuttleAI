"""Optional ML ETA microservice.
Trains a RandomForestRegressor on generated route telemetry for a reproducible demo.
Replace generated training rows with collected, consented operational history for real deployment.
"""
from fastapi import FastAPI
from pydantic import BaseModel, Field
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
import numpy as np
import joblib, os

app=FastAPI(title="SmartShuttle ETA AI",version="1.0")
MODEL_PATH=os.path.join(os.path.dirname(__file__),"eta_model.joblib")
rng=np.random.default_rng(17)

def train_model():
    n=5000
    distance=rng.uniform(.1,5.0,n) # km to next stop
    speed=rng.uniform(6,42,n)      # km/h
    dwell=rng.uniform(0,90,n)      # seconds
    delay=rng.uniform(0,420,n)     # seconds
    traffic=rng.uniform(.8,1.8,n)  # multiplier
    gps_age=rng.uniform(0,120,n)   # seconds
    slope=rng.uniform(0,.08,n)
    base=distance/(np.maximum(speed,5)/3.6)*traffic + dwell + delay
    target=base*(1+slope)+gps_age*.12+rng.normal(0,13,n)
    X=np.column_stack([distance,speed,dwell,delay,traffic,gps_age,slope])
    X_train,X_test,y_train,y_test=train_test_split(X,target,test_size=.2,random_state=42)
    model=RandomForestRegressor(n_estimators=180,max_depth=16,min_samples_leaf=2,n_jobs=-1,random_state=42)
    model.fit(X_train,y_train)
    mae=mean_absolute_error(y_test,model.predict(X_test))
    joblib.dump(model,MODEL_PATH)
    return model,mae
if os.path.exists(MODEL_PATH):
    model=joblib.load(MODEL_PATH); validation_mae=None
else:model,validation_mae=train_model()

class ETARequest(BaseModel):
    distance_km:float=Field(ge=0,le=20)
    speed_kmh:float=Field(gt=0,le=100)
    dwell_seconds:float=0
    delay_seconds:float=0
    traffic_multiplier:float=1.0
    gps_age_seconds:float=0
    slope_factor:float=0

@app.get("/health")
def health(): return {"ok":True,"model":"RandomForestRegressor","validation_mae_seconds":validation_mae}
@app.post("/predict")
def predict(data:ETARequest):
    x=np.array([[data.distance_km,data.speed_kmh,data.dwell_seconds,data.delay_seconds,data.traffic_multiplier,data.gps_age_seconds,data.slope_factor]])
    seconds=max(20,float(model.predict(x)[0]))
    return {"eta_seconds":round(seconds),"eta_minutes":round(seconds/60,1),"model":"RandomForestRegressor","confidence":"demo-model; validate with real arrival labels"}
