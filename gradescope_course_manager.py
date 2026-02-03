import json
from pathlib import Path
import time

COURSES_FILE = "courses.json"

def load_courses_from_json():
    """Loads the course data from courses.json if it exists."""
    if Path(COURSES_FILE).exists():
        with open(COURSES_FILE, 'r') as f:
            return json.load(f)
    return {}

def save_courses_to_json(courses_data):
    """Saves the course data to courses.json."""
    with open(COURSES_FILE, 'w') as f:
        json.dump(courses_data, f, indent=4)

def update_course_data(discovered_courses):
    """
    Updates the courses.json file with the latest discovered courses.
    Adds new courses and updates timestamps for existing ones.
    """
    courses_data = load_courses_from_json()
    
    for course in discovered_courses:
        course_id = course['url'] # Use URL as a unique ID
        if course_id not in courses_data:
            courses_data[course_id] = {
                'full_name': course['full_name'],
                'short_name': course['short_name'],
                'term': course['term'],
                'url': course['url'],
                'timestamp': time.time(),
                'rename': ""
            }
        else:
            # Update existing course with the latest info, if needed, and timestamp
            courses_data[course_id]['full_name'] = course['full_name']
            courses_data[course_id]['short_name'] = course['short_name']
            courses_data[course_id]['term'] = course['term']
            courses_data[course_id]['timestamp'] = time.time()
            
    save_courses_to_json(courses_data)
    print(f"Updated {COURSES_FILE} with {len(discovered_courses)} courses.")
    return courses_data
