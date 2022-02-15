import { MapModel } from "@vertigis/web/mapping";
import {
    ComponentModelBase,
    serializable,
    PropertyDefs,
    ComponentModelProperties,
    importModel,
} from "@vertigis/web/models";

type ElevationProfileModelProperties = ComponentModelProperties;

@serializable
export default class ElevationProfileModel extends ComponentModelBase<ElevationProfileModelProperties> {
    @importModel("map-extension")
    map: MapModel | undefined;

    protected _getSerializableProperties(): PropertyDefs<ElevationProfileModelProperties> {
        const props = super._getSerializableProperties();
        return {
            ...props,
            title: {
                ...this._toPropertyDef(props.title),
                default: "language-web-incubator-elevation-profile-3d-title",
            },
            icon: {
                ...this._toPropertyDef(props.icon),
                default: "map-3rd-party",
            },
        };
    }
}
