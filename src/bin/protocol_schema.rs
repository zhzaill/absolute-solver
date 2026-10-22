use std::{env, fs, path::PathBuf};

use absolute_solver::wire::{HubState, WireEnvelope, PROTOCOL_NAME, PROTOCOL_VERSION};
use schemars::schema_for;

fn write_schema<T: schemars::JsonSchema>(
    directory: &PathBuf,
    file_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let schema = schema_for!(T);
    let json = serde_json::to_string_pretty(&schema)?;
    fs::write(directory.join(file_name), format!("{json}\n"))?;
    Ok(())
}

fn write_wire_schema(directory: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let schema = schema_for!(WireEnvelope);
    let mut value = serde_json::to_value(schema)?;
    value["required"] = serde_json::json!(["v"]);
    value["properties"]["v"] = serde_json::json!({
        "type": "integer",
        "format": "uint16",
        "enum": [PROTOCOL_VERSION],
        "default": PROTOCOL_VERSION,
    });
    fs::write(
        directory.join("absolute-solver.wire.v1.schema.json"),
        format!("{}\n", serde_json::to_string_pretty(&value)?),
    )?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(env::args().nth(1).unwrap_or_else(|| "schemas".into()));
    fs::create_dir_all(&directory)?;

    write_wire_schema(&directory)?;
    write_schema::<HubState>(&directory, "absolute-solver.state.v1.schema.json")?;

    let manifest = serde_json::json!({
        "protocol": PROTOCOL_NAME,
        "version": PROTOCOL_VERSION,
        "wireSchema": "absolute-solver.wire.v1.schema.json",
        "stateSchema": "absolute-solver.state.v1.schema.json",
    });
    fs::write(
        directory.join("absolute-solver.v1.manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    Ok(())
}
