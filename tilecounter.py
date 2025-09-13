import json
import os
import math

def get_tile_file_path(tile_x, tile_y):
    """Get the file path for a tile based on the directory structure"""
    sub_dir1 = math.floor(tile_x / 64)
    sub_dir2 = math.floor(tile_y / 64)
    return os.path.join('tiles', str(sub_dir1), str(sub_dir2), f'{tile_x}_{tile_y}.png')

def main():
    # Read the JSON file
    try:
        with open('downloaded_tiles.json', 'r') as f:
            data = json.load(f)
    except FileNotFoundError:
        print("Error: downloaded_tiles.json not found")
        return
    except json.JSONDecodeError:
        print("Error: Invalid JSON format")
        return
    
    # Convert arrays back to sets for easier lookup
    downloaded_tiles = set(data.get('downloaded', []))
    empty_tiles = set(data.get('empty', []))
    
    # Filter tiles within the specified range
    # X: [598, 606] inclusive, Y: under 1450
    filtered_tiles = []
    for tile_key in downloaded_tiles:
        try:
            x, y = map(int, tile_key.split('-'))
            if 598 <= x <= 606 and y < 1450:
                filtered_tiles.append((x, y, tile_key))
        except (ValueError, IndexError):
            print(f"Warning: Invalid tile key format: {tile_key}")
            continue
    
    print(f"Found {len(filtered_tiles)} tiles in range X:[598,606], Y:<1450")
    
    # Count empty vs non-empty tiles
    empty_count = 0
    non_empty_count = 0
    total_file_size = 0
    missing_files = 0
    
    for x, y, tile_key in filtered_tiles:
        if tile_key in empty_tiles:
            empty_count += 1
            continue
        else:
            non_empty_count += 1
        
        # Check file size
        file_path = get_tile_file_path(x, y)
        if os.path.exists(file_path):
            try:
                file_size = os.path.getsize(file_path)
                total_file_size += file_size
            except OSError as e:
                print(f"Warning: Could not get size of {file_path}: {e}")
        else:
            missing_files += 1
            print(f"Warning: File not found: {file_path}")
    
    # Print results
    print(f"\nTile Analysis Results:")
    print(f"Empty tiles: {empty_count}")
    print(f"Non-empty tiles: {non_empty_count}")
    print(f"Total tiles analyzed: {empty_count + non_empty_count}")
    
    print(f"\nFile Analysis Results:")
    print(f"Total file size: {total_file_size:,} bytes ({total_file_size / (1024*1024):.2f} MB)")
    print(f"Missing files: {missing_files}")
    
    if filtered_tiles:
        avg_size = total_file_size / (non_empty_count - missing_files) if non_empty_count > missing_files else 0
        print(f"Average file size: {avg_size:.2f} bytes")

if __name__ == "__main__":
    main()