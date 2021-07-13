import { MapModel } from "@vertigis/web/mapping";
import {
    ComponentModelBase,
    serializable,
    importModel,
    PropertyDefs,
    ComponentModelProperties,
} from "@vertigis/web/models";
import { throttle } from "@vertigis/web/ui";
import Point from "esri/geometry/Point";
import { Viewer, Node } from "mapillary-js";

interface MapillaryModelProperties extends ComponentModelProperties {
    mapillaryKey?: string;
    searchRadius?: number;
    defaultScale?: number;
    startSynced?: boolean;
}

interface MapillaryCamera {
    latitude: number;
    longitude: number;
    heading: number;
    tilt: number;
    fov: number;
}

/**
 *  Convert Mapillary bearing to a Scene's camera rotation.
 *  @param bearing Mapillary bearing in degrees (degrees relative to due north).
 *  @returns Scene camera rotation in degrees (degrees rotation of due north).
 */
function getCameraRotationFromBearing(bearing: number): number {
    return 360 - bearing;
}

@serializable
export default class MapillaryModel extends ComponentModelBase<MapillaryModelProperties> {
    mapillaryKey: string;
    searchRadius: number;
    defaultScale: number;
    startSynced: boolean;
    synchronizePosition: boolean;

    readonly imageQueryUrl = "https://a.mapillary.com/v3/images";

    // The latest location received from a locationmarker.update event
    currentMarkerPosition: { latitude: number; longitude: number };
    updating = false;

    // The computed position of the current Mapillary node
    private _currentNodePosition: { lat: number; lon: number };

    private _awaitViewHandle: IHandle;
    private _viewerUpdateHandle: IHandle;
    private _handleMarkerUpdate = true;
    private _synced = false;

    private _mapillary: any | undefined;
    get mapillary(): any | undefined {
        return this._mapillary;
    }
    set mapillary(instance: any | undefined) {
        if (instance === this._mapillary) {
            return;
        }

        this._viewerUpdateHandle?.remove();

        // If an instance already exists, clean it up first.
        if (this._mapillary) {
            // Clean up event handlers.
            this.mapillary.off(Viewer.nodechanged, this._onNodeChange);
            this.mapillary.off(Viewer.povchanged, this._onPerspectiveChange);

            // Activating the cover appears to be the best way to "clean up" Mapillary.
            // https://github.com/mapillary/mapillary-js/blob/8b6fc2f36e3011218954d95d601062ff6aa41ad9/src/viewer/ComponentController.ts#L184-L192
            this.mapillary.activateCover();

            void this._unsyncMaps();
        }

        this._mapillary = instance;

        // A new instance is being set - add the event handlers.
        if (instance) {
            // Listen for changes to the currently displayed mapillary node
            this.mapillary.on(Viewer.nodechanged, this._onNodeChange);

            // Change the current mapillary node when the location marker is moved.
            this._viewerUpdateHandle =
                this.messages.events.locationMarker.updated.subscribe((event) =>
                    this._handleViewerUpdate(event)
                );
        }

        // We may need to sync if the map and initialized view have arrived first.
        if (!this._synced && this.map.view) {
            void this._syncMaps();
        }
    }

    private _map: MapModel | undefined;
    get map(): MapModel | undefined {
        return this._map;
    }
    @importModel("map-extension")
    set map(instance: MapModel | undefined) {
        if (instance === this._map) {
            return;
        }

        // If an instance already exists, clean it up first.
        if (this._map) {
            void this._unsyncMaps();
        }
        this._map = instance;

        // We may need to wait for the view to arrive before proceeding.
        this._awaitViewHandle = this.watch("map.view", (view) => {
            if (view) {
                this._awaitViewHandle.remove();
                void this._syncMaps();
            }
        });
    }

    async recenter(): Promise<void> {
        const { latitude, longitude, heading } =
            await this._getMapillaryCamera();

        const centerPoint = new Point({
            latitude,
            longitude,
        });

        await this.messages.commands.map.zoomToViewpoint.execute({
            maps: this.map,
            viewpoint: {
                rotation: getCameraRotationFromBearing(heading),
                targetGeometry: centerPoint,
                scale: this.defaultScale,
            },
        });
    }

    async moveCloseToPosition(
        latitude: number,
        longitude: number
    ): Promise<void> {
        try {
            // https://www.mapillary.com/developer/api-documentation/#images
            const url = `${this.imageQueryUrl}?client_id=${this.mapillaryKey}&closeto=${longitude},${latitude}&radius=${this.searchRadius}`;
            const response = await fetch(url);
            const data = await response.json();
            const imgKey = data?.features?.[0]?.properties?.key;

            if (imgKey) {
                await this.mapillary.moveToKey(imgKey);
                this.updating = false;
            } else {
                this.updating = false;
                this._activateCover();
            }
        } catch {
            this.updating = false;
            this._activateCover();
        }
    }

    /**
     * Setup the initial state of the maps such as the location marker and map
     * position.
     */
    private async _syncMaps(): Promise<void> {
        if (!this.map || !this.mapillary || this._synced) {
            return;
        }

        this._synced = true;
        this.synchronizePosition = this.startSynced ?? true;

        // Set mapillary as close as possible to the center of the view
        await this.moveCloseToPosition(
            this.map.view.center.latitude,
            this.map.view.center.longitude
        );

        // Create location marker based on current location from Mapillary and
        // pan/zoom Geocortex map to the location.
        const { latitude, longitude, heading, tilt, fov } =
            await this._getMapillaryCamera();

        const centerPoint = new Point({ latitude, longitude });
        await Promise.all([
            this.messages.commands.locationMarker.create.execute({
                fov,
                geometry: centerPoint,
                heading,
                tilt,
                id: this.id,
                maps: this.map,
                userDraggable: true,
            }),
            this.synchronizePosition
                ? this.messages.commands.map.zoomToViewpoint.execute({
                      maps: this.map,
                      viewpoint: {
                          rotation: getCameraRotationFromBearing(heading),
                          targetGeometry: centerPoint,
                          scale: this.defaultScale,
                      },
                  })
                : undefined,
        ]);
    }

    private async _unsyncMaps(): Promise<void> {
        this._synced = false;

        await this.messages.commands.locationMarker.remove.execute({
            id: this.id,
            maps: this.map,
        });
    }

    private _handleViewerUpdate(event: any): void {
        if (this._handleMarkerUpdate) {
            const updatePoint = event.geometry as Point;
            this.currentMarkerPosition = {
                latitude: updatePoint.latitude,
                longitude: updatePoint.longitude,
            };
        }
        this._handleMarkerUpdate = true;
    }

    /**
     * When the 'merged' property is set on the node we know that the position
     * reported will be the computed location rather than a raw GPS value. We
     * ignore all updates sent while the computed position is unknown as the raw
     * GPS value can be inaccurate and will not exactly match the observed
     * position of the camera. See:
     * https://bl.ocks.org/oscarlorentzon/16946cb9eedfad2a64669cb1121e6c75
     */
    private _onNodeChange = (node: Node) => {
        if (node.merged) {
            this._currentNodePosition = node.latLon;

            // Set the initial marker position for this node.
            this._onPerspectiveChange();

            // Handle further pov changes.
            this.mapillary.on(Viewer.povchanged, this._onPerspectiveChange);
        } else {
            this._currentNodePosition = undefined;
            this.mapillary.off(Viewer.povchanged, this._onPerspectiveChange);
        }
    };

    /**
     * Handles pov changes once the node position is known.
     */
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    private _onPerspectiveChange = throttle(async () => {
        if (!this.map || !this.mapillary || this.updating) {
            return;
        }

        this.updating = true;

        const { latitude, longitude, heading, tilt, fov } =
            await this._getMapillaryCamera();

        const centerPoint = new Point({
            latitude,
            longitude,
        });

        this._handleMarkerUpdate = false;

        await Promise.all([
            this.messages.commands.locationMarker.update.execute({
                geometry: centerPoint,
                heading,
                tilt,
                fov,
                id: this.id,
                maps: this.map,
            }),
            this.synchronizePosition
                ? this.messages.commands.map.zoomToViewpoint.execute({
                      maps: this.map,
                      viewpoint: {
                          rotation: getCameraRotationFromBearing(heading),
                          targetGeometry: centerPoint,
                          scale: this.defaultScale,
                      },
                  })
                : undefined,
        ]).finally(() => (this.updating = false));
    }, 128);

    /**
     * Gets the current POV of the mapillary camera
     */
    private async _getMapillaryCamera(): Promise<MapillaryCamera | undefined> {
        if (!this.mapillary) {
            return undefined;
        }

        // Will return a raw GPS value if the node position has not yet been calculated.
        const [{ lat, lon }, { bearing, tilt }, fov] = await Promise.all([
            this._currentNodePosition ?? this.mapillary.getPosition(),
            this.mapillary.getPointOfView() as Promise<{
                bearing: number;
                tilt: number;
            }>,
            this.mapillary.getFieldOfView(),
        ]);

        return {
            latitude: lat,
            longitude: lon,
            heading: bearing,
            tilt: tilt + 90,
            fov,
        };
    }

    private _activateCover() {
        this.updating = false;
        this.mapillary.activateCover();
    }

    protected async _onDestroy(): Promise<void> {
        await super._onDestroy();
        this._viewerUpdateHandle?.remove();
        this._awaitViewHandle?.remove();
    }

    protected _getSerializableProperties(): PropertyDefs<MapillaryModelProperties> {
        const props = super._getSerializableProperties();
        return {
            ...props,
            mapillaryKey: {
                serializeModes: ["initial"],
                default: "",
            },
            searchRadius: {
                serializeModes: ["initial"],
                default: 500,
            },
            defaultScale: {
                serializeModes: ["initial"],
                default: 3000,
            },
            startSynced: {
                serializeModes: ["initial"],
                default: true,
            },
            title: {
                ...this._toPropertyDef(props.title),
                default: "language-web-incubator-mapillary-title",
            },
            icon: {
                ...this._toPropertyDef(props.icon),
                default: "map-3rd-party",
            },
        };
    }
}
