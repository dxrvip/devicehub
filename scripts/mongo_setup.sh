#!/bin/bash

mongosh --host 8.163.31.31:27017 <<EOF
    rs.initiate({
        _id:'devicehub-rs',
        members: [
            {
                _id:0,
                host:'8.163.31.31:27017',
                priority: 2
            }
        ]
    })
EOF
