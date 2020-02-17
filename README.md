# zootopia-playlist-generator
**Creates Spotify playlists from recent songs played on KZSU Zootopia.**

[KZSU Zootopia](http://kzsu.rocks/) is a streaming service of excellent college rock from Stanford. I love it, and their tastes are very aligned with mine.
However, the stream is inconvenient so I wrote these cloud functions to scrape the Zootopia website and create a daily Spotify playlist.

* Every hour, a cloud function running on Google's Firebase service queries the Zootopia website for the last 25 played songs.
* These tracks are stored to the Firebase Firestore database.
* At 3am, a cloud function gets all the songs played in the previous day from the database, generates a new playlist for the day, and updates a dynamic playlist of yesterday's songs.
* The [spotify dynamic playlist can be found here.](https://open.spotify.com/playlist/08k6syCThIt44yLGiabDLf)

In order to run the cloud functions, you'll need to rename functions/config_template.json to functions/config.json, and replace the values with the appropriate credentials.

**Special thanks to KZSU for creating such an amazing mix of awesome music!**
