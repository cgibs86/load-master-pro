/*
 * LoadMaster Pro AI — US climate design data
 *
 * Representative US locations with ASHRAE-style design conditions:
 *   heating99  = 99% winter design dry-bulb temperature (°F)
 *   cooling1   = 1% summer design dry-bulb temperature (°F)
 *   outGrains  = approximate design outdoor humidity ratio (grains of moisture / lb dry air)
 *                used for the latent (humidity) portion of the cooling load.
 *   elevFt     = approximate station elevation (ft above sea level), used for the
 *                air-density correction when live TrueClimate data isn't available.
 *
 * The app geocodes an address to lat/lon, then picks the nearest location
 * in this table (great-circle distance). Values are design-condition
 * approximations suitable for a sizing estimate, not a stamped engineering report.
 */
window.CLIMATE_DATA = [
  { city: "Birmingham, AL",     lat: 33.52, lon: -86.80, heating99: 21, cooling1: 95, outGrains: 120, elevFt: 645 },
  { city: "Anchorage, AK",      lat: 61.22, lon: -149.90, heating99: -8, cooling1: 71, outGrains: 50, elevFt: 102 },
  { city: "Phoenix, AZ",        lat: 33.45, lon: -112.07, heating99: 37, cooling1: 108, outGrains: 70, elevFt: 1086 },
  { city: "Tucson, AZ",         lat: 32.22, lon: -110.97, heating99: 33, cooling1: 102, outGrains: 75, elevFt: 2389 },
  { city: "Little Rock, AR",    lat: 34.75, lon: -92.29, heating99: 20, cooling1: 96, outGrains: 120, elevFt: 257 },
  { city: "Los Angeles, CA",    lat: 34.05, lon: -118.24, heating99: 43, cooling1: 83, outGrains: 80, elevFt: 305 },
  { city: "Sacramento, CA",     lat: 38.58, lon: -121.49, heating99: 32, cooling1: 98, outGrains: 65, elevFt: 30 },
  { city: "San Francisco, CA",  lat: 37.77, lon: -122.42, heating99: 40, cooling1: 79, outGrains: 75, elevFt: 52 },
  { city: "San Diego, CA",      lat: 32.72, lon: -117.16, heating99: 44, cooling1: 81, outGrains: 85, elevFt: 62 },
  { city: "Fresno, CA",         lat: 36.75, lon: -119.77, heating99: 31, cooling1: 100, outGrains: 70, elevFt: 328 },
  { city: "Denver, CO",         lat: 39.74, lon: -104.99, heating99: 3, cooling1: 92, outGrains: 55, elevFt: 5280 },
  { city: "Hartford, CT",       lat: 41.76, lon: -72.69, heating99: 5, cooling1: 88, outGrains: 105, elevFt: 40 },
  { city: "Wilmington, DE",     lat: 39.74, lon: -75.55, heating99: 13, cooling1: 91, outGrains: 110, elevFt: 72 },
  { city: "Washington, DC",     lat: 38.90, lon: -77.04, heating99: 16, cooling1: 92, outGrains: 110, elevFt: 25 },
  { city: "Jacksonville, FL",   lat: 30.33, lon: -81.66, heating99: 31, cooling1: 94, outGrains: 130, elevFt: 16 },
  { city: "Miami, FL",          lat: 25.76, lon: -80.19, heating99: 46, cooling1: 91, outGrains: 135, elevFt: 6 },
  { city: "Orlando, FL",        lat: 28.54, lon: -81.38, heating99: 38, cooling1: 93, outGrains: 130, elevFt: 82 },
  { city: "Tampa, FL",          lat: 27.95, lon: -82.46, heating99: 40, cooling1: 92, outGrains: 130, elevFt: 48 },
  { city: "Atlanta, GA",        lat: 33.75, lon: -84.39, heating99: 23, cooling1: 93, outGrains: 115, elevFt: 1050 },
  { city: "Savannah, GA",       lat: 32.08, lon: -81.09, heating99: 27, cooling1: 94, outGrains: 130, elevFt: 42 },
  { city: "Honolulu, HI",       lat: 21.31, lon: -157.86, heating99: 63, cooling1: 88, outGrains: 125, elevFt: 13 },
  { city: "Boise, ID",          lat: 43.62, lon: -116.20, heating99: 10, cooling1: 96, outGrains: 50, elevFt: 2704 },
  { city: "Chicago, IL",        lat: 41.88, lon: -87.63, heating99: -2, cooling1: 91, outGrains: 105, elevFt: 594 },
  { city: "Indianapolis, IN",   lat: 39.77, lon: -86.16, heating99: 2, cooling1: 90, outGrains: 110, elevFt: 715 },
  { city: "Des Moines, IA",     lat: 41.59, lon: -93.62, heating99: -5, cooling1: 91, outGrains: 110, elevFt: 928 },
  { city: "Wichita, KS",        lat: 37.69, lon: -97.34, heating99: 7, cooling1: 99, outGrains: 105, elevFt: 1299 },
  { city: "Louisville, KY",     lat: 38.25, lon: -85.76, heating99: 12, cooling1: 93, outGrains: 115, elevFt: 466 },
  { city: "New Orleans, LA",    lat: 29.95, lon: -90.07, heating99: 33, cooling1: 93, outGrains: 135, elevFt: 3 },
  { city: "Portland, ME",       lat: 43.66, lon: -70.26, heating99: -1, cooling1: 85, outGrains: 100, elevFt: 62 },
  { city: "Baltimore, MD",      lat: 39.29, lon: -76.61, heating99: 14, cooling1: 92, outGrains: 110, elevFt: 33 },
  { city: "Boston, MA",         lat: 42.36, lon: -71.06, heating99: 9, cooling1: 88, outGrains: 105, elevFt: 141 },
  { city: "Detroit, MI",        lat: 42.33, lon: -83.05, heating99: 4, cooling1: 88, outGrains: 105, elevFt: 600 },
  { city: "Minneapolis, MN",    lat: 44.98, lon: -93.27, heating99: -11, cooling1: 89, outGrains: 100, elevFt: 830 },
  { city: "Jackson, MS",        lat: 32.30, lon: -90.18, heating99: 25, cooling1: 95, outGrains: 130, elevFt: 291 },
  { city: "Kansas City, MO",    lat: 39.10, lon: -94.58, heating99: 4, cooling1: 95, outGrains: 110, elevFt: 910 },
  { city: "St. Louis, MO",      lat: 38.63, lon: -90.20, heating99: 6, cooling1: 95, outGrains: 110, elevFt: 466 },
  { city: "Billings, MT",       lat: 45.78, lon: -108.50, heating99: -10, cooling1: 92, outGrains: 50, elevFt: 3123 },
  { city: "Omaha, NE",          lat: 41.26, lon: -95.93, heating99: -4, cooling1: 92, outGrains: 105, elevFt: 1090 },
  { city: "Las Vegas, NV",      lat: 36.17, lon: -115.14, heating99: 31, cooling1: 106, outGrains: 50, elevFt: 2001 },
  { city: "Reno, NV",           lat: 39.53, lon: -119.81, heating99: 14, cooling1: 94, outGrains: 40, elevFt: 4505 },
  { city: "Manchester, NH",     lat: 42.99, lon: -71.46, heating99: -3, cooling1: 87, outGrains: 100, elevFt: 253 },
  { city: "Newark, NJ",         lat: 40.74, lon: -74.17, heating99: 11, cooling1: 91, outGrains: 110, elevFt: 30 },
  { city: "Albuquerque, NM",    lat: 35.08, lon: -106.65, heating99: 17, cooling1: 96, outGrains: 45, elevFt: 5312 },
  { city: "Albany, NY",         lat: 42.65, lon: -73.75, heating99: -1, cooling1: 87, outGrains: 100, elevFt: 285 },
  { city: "Buffalo, NY",        lat: 42.89, lon: -78.88, heating99: 3, cooling1: 86, outGrains: 100, elevFt: 600 },
  { city: "New York, NY",       lat: 40.71, lon: -74.01, heating99: 13, cooling1: 91, outGrains: 108, elevFt: 33 },
  { city: "Charlotte, NC",      lat: 35.23, lon: -80.84, heating99: 22, cooling1: 93, outGrains: 115, elevFt: 751 },
  { city: "Raleigh, NC",        lat: 35.78, lon: -78.64, heating99: 20, cooling1: 93, outGrains: 118, elevFt: 315 },
  { city: "Fargo, ND",          lat: 46.88, lon: -96.79, heating99: -18, cooling1: 90, outGrains: 95, elevFt: 902 },
  { city: "Cincinnati, OH",     lat: 39.10, lon: -84.51, heating99: 6, cooling1: 91, outGrains: 110, elevFt: 550 },
  { city: "Cleveland, OH",      lat: 41.50, lon: -81.69, heating99: 5, cooling1: 88, outGrains: 105, elevFt: 653 },
  { city: "Columbus, OH",       lat: 39.96, lon: -83.00, heating99: 5, cooling1: 90, outGrains: 108, elevFt: 902 },
  { city: "Oklahoma City, OK",  lat: 35.47, lon: -97.52, heating99: 13, cooling1: 99, outGrains: 110, elevFt: 1201 },
  { city: "Portland, OR",       lat: 45.52, lon: -122.68, heating99: 26, cooling1: 89, outGrains: 60, elevFt: 50 },
  { city: "Philadelphia, PA",   lat: 39.95, lon: -75.17, heating99: 14, cooling1: 92, outGrains: 110, elevFt: 39 },
  { city: "Pittsburgh, PA",     lat: 40.44, lon: -79.996, heating99: 5, cooling1: 89, outGrains: 105, elevFt: 745 },
  { city: "Providence, RI",     lat: 41.82, lon: -71.41, heating99: 6, cooling1: 88, outGrains: 105, elevFt: 60 },
  { city: "Columbia, SC",       lat: 34.00, lon: -81.03, heating99: 24, cooling1: 96, outGrains: 122, elevFt: 291 },
  { city: "Sioux Falls, SD",    lat: 43.55, lon: -96.70, heating99: -11, cooling1: 91, outGrains: 100, elevFt: 1420 },
  { city: "Memphis, TN",        lat: 35.15, lon: -90.05, heating99: 21, cooling1: 96, outGrains: 122, elevFt: 337 },
  { city: "Nashville, TN",      lat: 36.16, lon: -86.78, heating99: 16, cooling1: 94, outGrains: 118, elevFt: 597 },
  { city: "Austin, TX",         lat: 30.27, lon: -97.74, heating99: 30, cooling1: 99, outGrains: 120, elevFt: 489 },
  { city: "Dallas, TX",         lat: 32.78, lon: -96.80, heating99: 24, cooling1: 100, outGrains: 115, elevFt: 430 },
  { city: "Houston, TX",        lat: 29.76, lon: -95.37, heating99: 32, cooling1: 96, outGrains: 130, elevFt: 80 },
  { city: "San Antonio, TX",    lat: 29.42, lon: -98.49, heating99: 31, cooling1: 99, outGrains: 122, elevFt: 650 },
  { city: "El Paso, TX",        lat: 31.76, lon: -106.49, heating99: 25, cooling1: 100, outGrains: 55, elevFt: 3740 },
  { city: "Salt Lake City, UT", lat: 40.76, lon: -111.89, heating99: 11, cooling1: 96, outGrains: 50, elevFt: 4226 },
  { city: "Burlington, VT",     lat: 44.48, lon: -73.21, heating99: -7, cooling1: 86, outGrains: 95, elevFt: 340 },
  { city: "Richmond, VA",       lat: 37.54, lon: -77.44, heating99: 18, cooling1: 94, outGrains: 115, elevFt: 166 },
  { city: "Seattle, WA",        lat: 47.61, lon: -122.33, heating99: 28, cooling1: 84, outGrains: 65, elevFt: 175 },
  { city: "Spokane, WA",        lat: 47.66, lon: -117.43, heating99: 5, cooling1: 92, outGrains: 50, elevFt: 1843 },
  { city: "Charleston, WV",     lat: 38.35, lon: -81.63, heating99: 11, cooling1: 90, outGrains: 110, elevFt: 601 },
  { city: "Milwaukee, WI",      lat: 43.04, lon: -87.91, heating99: -4, cooling1: 88, outGrains: 100, elevFt: 617 },
  { city: "Cheyenne, WY",       lat: 41.14, lon: -104.82, heating99: -3, cooling1: 86, outGrains: 45, elevFt: 6062 }
];
